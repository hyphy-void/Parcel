// V3 owns the E2EE protocol. The independent Go/origin build retains its own UI.
if (import.meta.env.VITE_ADMIN_AUTH === "v3") {
  void import("./main-v3");
} else {
  void import("./main-origin");
}
