"""Prepare reviewed tutorial PNGs with solid example labels and lossless WebP.

Usage: python scripts/prepare-tutorial-images.py /path/to/deploy-pic
Originals stay untouched. Expected dimensions prevent applying these reviewed
rectangles to a different capture. A fresh RGB encoding drops source metadata.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
# Mask coordinates and font sizes use the review viewport; scale to source pixels.
REVIEWED = {
    'add-secret': ((1217, 680), (1217, 680), []),
    'bindings': ((1788, 636), (1788, 636), [
        ((823, 222, 1510, 279), 'Namespace ID: YOUR_ADMIN_NAMESPACE_ID', 28),
        ((823, 322, 1510, 379), 'Namespace ID: YOUR_API_NAMESPACE_ID', 28),
    ]),
    'builds': ((1840, 2457), (1366, 1824), [
        ((590, 1310, 1203, 1352), 'YOUR_RESOURCE_CONFIG_JSON', 24),
    ]),
    'r2-cors': ((1395, 1266), (1395, 1266), [
        ((247, 374, 804, 414), 'https://parcel.example.com', 26),
    ]),
    'r2-token': ((2327, 2345), (2327, 2345), []),
    'template-build': ((2452, 1127), (2452, 1127), []),
}

# 2026-10-20 user-provided CORS refresh: mask only the origin. Policy values
# remain the actual dashboard capture, at its original pixel dimensions.
REFRESHED = {
    'r2-cors': REVIEWED['r2-cors'],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--only', nargs='+', choices=sorted(REVIEWED), help='Encode only the selected reviewed captures')
    parser.add_argument('--refresh', action='store_true', help='Encode the reviewed 2026-10-20 CORS capture only')
    parser.add_argument('--cors-complete', type=Path, help='Use the reviewed 1396x719 native dashboard capture after saving the complete CORS policy')
    default_font = 'C:/Windows/Fonts/segoeui.ttf'
    parser.add_argument('--font', default=default_font if Path(default_font).is_file() else 'DejaVuSans.ttf')
    args = parser.parse_args()
    target = ROOT / 'docs/site/images'
    target.mkdir(parents=True, exist_ok=True)
    captures = REFRESHED if args.refresh else REVIEWED
    if args.only:
        if any(name not in captures for name in args.only):
            parser.error('--only must name a capture available in the selected refresh')
        captures = {name: captures[name] for name in args.only}
    for name, (expected, review, labels) in captures.items():
        with Image.open(args.source / f'{name}.png') as source:
            if source.size != expected:
                raise ValueError(f'{name}: review changed dimensions {source.size} before redacting')
            output = Image.new('RGB', source.size, 'white')
            output.paste(source.convert('RGB'))
        draw = ImageDraw.Draw(output)
        sx, sy = output.width / review[0], output.height / review[1]
        for rect, label, size in labels:
            x1, y1, x2, y2 = [int(v * (sx if i % 2 == 0 else sy)) for i, v in enumerate(rect)]
            draw.rectangle((x1, y1, x2, y2), fill='#202020')
            font_size = round(size * sy)
            padding = round(8 * sx)
            font = ImageFont.truetype(args.font, font_size)
            while draw.textlength(label, font=font) > x2 - x1 - 2 * padding:
                font_size -= 1
                if font_size < 10:
                    raise ValueError(f'{name}: label does not fit its reviewed mask')
                font = ImageFont.truetype(args.font, font_size)
            draw.text((x1 + padding, (y1 + y2) / 2), label, font=font, fill='white', anchor='lm')
        destination = target / f'{name}.webp'
        output.save(destination, 'WEBP', lossless=True, method=6, exact=True)
        with Image.open(destination) as encoded:
            if encoded.convert('RGB').tobytes() != output.tobytes():
                raise ValueError(f'{name}: lossless pixel verification failed')
        print(f'{name}.webp: {output.width}x{output.height}, {len(labels)} example labels')
    if args.cors_complete:
        with Image.open(args.cors_complete) as source:
            if source.size != (1396, 719):
                raise ValueError('Review the new CORS capture before applying the crop and origin mask')
            output = source.convert('RGB').crop((355, 65, 1030, 705))
        draw = ImageDraw.Draw(output)
        draw.rectangle((123, 183, 428, 204), fill='#202020')
        draw.text((130, 194), 'https://parcel.example.com', font=ImageFont.truetype(args.font, 13), fill='white', anchor='lm')
        destination = target / 'r2-cors.webp'
        output.save(destination, 'WEBP', lossless=True, method=6, exact=True)
        with Image.open(destination) as encoded:
            if encoded.convert('RGB').tobytes() != output.tobytes():
                raise ValueError('Complete CORS: lossless pixel verification failed')
        print(f'r2-cors.webp: {output.width}x{output.height}, saved policy with complete request headers')


if __name__ == '__main__':
    main()
