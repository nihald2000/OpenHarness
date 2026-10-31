import os from "node:os";

export const isWindows = os.platform() === "win32";
export const skipOnWindows = isWindows ? { skip: "Requires POSIX shell/symlinks" } : {};
export const hasModal = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
