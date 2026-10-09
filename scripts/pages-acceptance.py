#!/usr/bin/env python3
"""Read-only public checks after the Pages/Access cutover; no credentials needed."""
import argparse
import json
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError('Use an HTTPS origin without a trailing slash')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, type=origin)
    parser.add_argument('--origin-url', required=True, type=origin)
    args = parser.parse_args()
    opener = urllib.request.build_opener(NoRedirect())
    failures = []

    def check(label, url, statuses, json_code=None, access_redirect=False):
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 Parcel-Acceptance', 'Cache-Control': 'no-cache'})
        try:
            try:
                response = opener.open(request, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                assert status in statuses, f'unexpected HTTP {status}'
                if status == 302 and access_redirect:
                    location = urllib.parse.urlsplit(response.headers.get('Location', ''))
                    assert location.scheme == 'https' and location.hostname and location.hostname.endswith('.cloudflareaccess.com'), 'redirect is not Access'
                if json_code:
                    body = json.load(response)
                    assert body.get('code') == json_code, f'unexpected API result: {body.get("code")}'
                if status == 200:
                    assert response.headers.get('Referrer-Policy') == 'no-referrer', 'missing referrer protection'
            print(f'PASS {label}: HTTP {status}')
        except Exception as error:
            failures.append(label)
            print(f'FAIL {label}: {error}')

    check('Pages frontend', args.base_url + '/', {200})
    check('Public share page', args.base_url + '/s/' + 'a'*32, {200})
    check('Public nonexistent share API', args.base_url + '/api/v1/shares/' + 'a'*32, {404}, 'not_found')
    for path in ['/login', '/admin', '/admin/new', '/api/v1/auth/session', '/api/v1/admin/status', '/api/v1/uploads/lookup']:
        check('Access ' + path, args.base_url + path, {302, 401, 403}, access_redirect=True)
    for path in ['/readyz', '/healthz', '/api/v1/downloads/' + 'a'*32 + '/file', '/_worker.js']:
        check('Hidden ' + path, args.base_url + path, {404})
    check('Internal Origin denies browsers', args.origin_url + '/api/v1/admin/status', {302, 401, 403}, access_redirect=True)
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
