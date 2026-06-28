import { dlopen, FFIType, ptr } from "bun:ffi";

// openpty lives in libutil; on macOS those symbols are re-exported from
// libSystem. We bind it via FFI to allocate a real tty pair: the slave is
// handed to `script` (so its tcgetattr succeeds — a pipe made it fail), and we
// drive the master end while `script` gives the shell a controlling terminal.
const libName =
	process.platform === "darwin" ? "libSystem.dylib" : "libutil.so.1";

const { symbols } = dlopen(libName, {
	openpty: {
		args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
		returns: FFIType.int,
	},
});

export type Pty = { master: number; slave: number };

export function openPty(rows: number, cols: number): Pty {
	const master = new Int32Array(1);
	const slave = new Int32Array(1);
	// struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; }
	const winsize = new Uint16Array([rows, cols, 0, 0]);
	const rc = symbols.openpty(ptr(master), ptr(slave), null, null, ptr(winsize));
	if (rc !== 0) throw new Error("openpty() failed");
	return { master: master[0] ?? -1, slave: slave[0] ?? -1 };
}
