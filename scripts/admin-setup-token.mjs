import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Never print a bootstrap credential or put it in command-line arguments.
export async function createSetupToken(destination) {
  const root = fileURLToPath(new URL("../.parcel-v3/", import.meta.url));
  const path = resolve(root, destination || "admin-setup-token.txt");
  if (!path.startsWith(root))
    throw new Error("Save initialization secrets inside .parcel-v3 only.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, randomBytes(32).toString("base64url") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return path;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length > 3)
      throw new Error("Usage: npm run admin:setup-token -- [FILENAME]");
    const path = await createSetupToken(process.argv[2]);
    console.log(
      `Initialization secret saved to ${path}. Copy its contents to the ADMIN_SETUP_TOKEN Worker secret and use it once on the setup page. This command never overwrites an existing file.`,
    );
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "The initialization secret file already exists; reuse it or choose a new filename."
        : error.message,
    );
    process.exitCode = 1;
  }
}
