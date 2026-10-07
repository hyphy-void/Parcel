package parcel

import "testing"

func TestShareCodePolicy(t *testing.T) {
	f := testApp(t)
	if err := f.a.InitAdmin("abcd"); err == nil {
		t.Fatal("four-character code accepted as administrator password")
	}
	if _, err := hashSharePassword("abc"); err == nil {
		t.Fatal("share code shorter than four bytes accepted")
	}
	s := f.publish(t, []byte("protected by a short code"), "a2b3", 3)
	if w := f.request("POST", "/api/v1/shares/"+s.ID+"/unlock", map[string]string{"password": "a2b3"}, nil, false); w.Code != 200 {
		t.Fatalf("four-character share code rejected: %d %s", w.Code, w.Body.String())
	}
	if w := f.request("PATCH", "/api/v1/admin/shares/"+s.ID+"/password", map[string]string{"password": "c4d5"}, nil, true); w.Code != 200 {
		t.Fatalf("four-character replacement rejected: %d %s", w.Code, w.Body.String())
	}
	if w := f.request("POST", "/api/v1/shares/"+s.ID+"/unlock", map[string]string{"password": "a2b3"}, nil, false); w.Code != 401 {
		t.Fatal("old share code still accepted")
	}
	if w := f.request("POST", "/api/v1/shares/"+s.ID+"/unlock", map[string]string{"password": "c4d5"}, nil, false); w.Code != 200 {
		t.Fatalf("replacement share code rejected: %d", w.Code)
	}
}
