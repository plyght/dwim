import { dlopen, FFIType, ptr } from "bun:ffi";

// openpty lives in libutil; on macOS those symbols are re-exported from
// libSystem. We bind it via FFI so the child shell gets a genuine tty on its
// stdio — interactive mode, line editing, colors — while we drive the master
// end. This replaces the brittle `script` wrapper, which cannot work once we
// pipe stdin for interception (it tcgetattr's its own stdin and fails).
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
