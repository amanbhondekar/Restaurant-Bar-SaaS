import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * USB thermal-printer transport (M1 completion).
 *
 * A USB receipt printer shows up to the operating system as an installed
 * printer queue. We hand it raw ESC/POS bytes through the OS spooler, so no
 * native Node addon and no vendor driver SDK is needed:
 *
 *   - Windows:      winspool.drv OpenPrinter / WritePrinter with datatype RAW,
 *                   driven by a fixed PowerShell script.
 *   - Linux/macOS:  `lp -d <queue> -o raw`.
 *   - Linux device: write straight to /dev/usb/lpN (no CUPS), for kiosks.
 *
 * Safety: the printer name is untrusted (it comes from config / the admin
 * API), so it is NEVER interpolated into a command line or script. The
 * Windows script is a constant; the name and spool file reach it through
 * environment variables, and `lp` gets the name as a discrete argv entry.
 *
 * Everything that touches the OS goes through `usbDeps`, so tests can inject a
 * fake runner and platform and never need hardware.
 */

export const USB_TIMEOUT_MS = 15000;

const NAME_MAX = 120;
// Printer queue names may contain spaces and punctuation; control characters never.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Raw device nodes we are willing to write to. Anything else could let a config entry
// overwrite an arbitrary file.
const DEVICE_PATH_RE = /^\/dev\/(usb\/lp\d{1,2}|lp\d{1,2}|ttyUSB\d{1,2}|ttyACM\d{1,2})$/;

export function isValidSystemPrinterName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return n.length > 0 && n.length <= NAME_MAX && !CONTROL_CHARS.test(n);
}

export function isValidDevicePath(p) {
  return typeof p === 'string' && DEVICE_PATH_RE.test(p);
}

// ---------------------------------------------------------------------------
// Windows: constant PowerShell script. Name and file come from the environment.
// ---------------------------------------------------------------------------
export const WINDOWS_RAW_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$src = @"
using System;
using System.Runtime.InteropServices;

public class KullinaRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "OpenPrinter failed (error " + Marshal.GetLastWin32Error() + "): printer not found or not accessible";
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Kullina";
    di.pDataType = "RAW";
    string result = null;
    if (!StartDocPrinter(h, 1, di)) { result = "StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")"; }
    else {
      if (!StartPagePrinter(h)) { result = "StartPagePrinter failed (error " + Marshal.GetLastWin32Error() + ")"; }
      else {
        IntPtr p = Marshal.AllocCoTaskMem(data.Length);
        Marshal.Copy(data, 0, p, data.Length);
        int written;
        if (!WritePrinter(h, p, data.Length, out written)) result = "WritePrinter failed (error " + Marshal.GetLastWin32Error() + ")";
        else if (written != data.Length) result = "Short write: " + written + " of " + data.Length + " bytes";
        Marshal.FreeCoTaskMem(p);
        EndPagePrinter(h);
      }
      EndDocPrinter(h);
    }
    ClosePrinter(h);
    return result;
  }
}
"@
Add-Type -TypeDefinition $src
$bytes = [System.IO.File]::ReadAllBytes($env:KULLINA_FILE)
$err = [KullinaRawPrinter]::Send($env:KULLINA_PRINTER, $bytes)
if ($err) { [Console]::Error.WriteLine($err); exit 2 }
`;

export const WINDOWS_LIST_SCRIPT =
  "$ErrorActionPreference = 'Stop'; " +
  'Get-Printer | Select-Object Name, DriverName, PortName | ConvertTo-Json -Compress';

/** PowerShell's -EncodedCommand wants base64 of the UTF-16LE script: no quoting to get wrong. */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const POWERSHELL_ARGS = script => [
  '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', encodePowerShell(script)
];

/** First human-readable line of a process's stderr, with PowerShell's CLIXML progress noise removed. */
export function cleanStderr(text) {
  const lines = String(text || '').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#< CLIXML') && !l.startsWith('<Objs') && !l.startsWith('<'));
  return lines.join(' ').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Process runner (replaceable in tests).
// ---------------------------------------------------------------------------
function defaultRun(cmd, args, { env, input, timeoutMs = USB_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...(env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false, spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, timedOut, spawnError: true });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => { /* the process may exit before reading all input */ });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

/** Mutable on purpose: tests swap `run` and `platform` instead of needing hardware. */
export const usbDeps = {
  run: defaultRun,
  platform: () => process.platform,
  tmpdir: () => os.tmpdir()
};

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
export async function sendToUsbPrinter(buffer, systemName) {
  if (!Buffer.isBuffer(buffer)) return fail('INVALID_JOB', 'renderer produced no bytes');
  if (!isValidSystemPrinterName(systemName)) {
    return fail('INVALID_PRINTER_NAME', 'The printer name is missing or contains invalid characters.');
  }
  const name = systemName.trim();
  const platform = usbDeps.platform();

  if (platform === 'win32') {
    const file = path.join(usbDeps.tmpdir(), `kullina-spool-${crypto.randomBytes(8).toString('hex')}.bin`);
    try {
      fs.writeFileSync(file, buffer);
    } catch (err) {
      return fail('USB_SPOOL_FAILED', `Could not create the spool file: ${err.message}`);
    }
    try {
      const r = await usbDeps.run('powershell.exe', POWERSHELL_ARGS(WINDOWS_RAW_SCRIPT), {
        env: { KULLINA_PRINTER: name, KULLINA_FILE: file }
      });
      return interpret(r, buffer.length, name);
    } finally {
      try { fs.unlinkSync(file); } catch { /* already removed */ }
    }
  }

  if (platform === 'linux' || platform === 'darwin') {
    const r = await usbDeps.run('lp', ['-d', name, '-o', 'raw'], { input: buffer });
    return interpret(r, buffer.length, name);
  }

  return fail('USB_UNSUPPORTED_PLATFORM', `USB printing is not supported on ${platform}.`);
}

function interpret(r, bytes, name) {
  if (r.timedOut) return fail('USB_TIMEOUT', `Printer "${name}" did not accept the job in time.`);
  if (r.spawnError) return fail('USB_SPOOL_FAILED', `Could not start the print command: ${r.stderr}`);
  if (r.code !== 0) {
    return fail('USB_SPOOL_FAILED', cleanStderr(r.stderr) || cleanStderr(r.stdout) || `The print command failed (exit ${r.code}).`);
  }
  return { ok: true, sent_bytes: bytes };
}

/** Raw device node (Linux kiosks without CUPS). */
export async function sendToDevice(buffer, devicePath) {
  if (!Buffer.isBuffer(buffer)) return fail('INVALID_JOB', 'renderer produced no bytes');
  if (!isValidDevicePath(devicePath)) {
    return fail('INVALID_DEVICE_PATH', 'Device path must be a printer device such as /dev/usb/lp0.');
  }
  try {
    await Promise.race([
      fs.promises.writeFile(devicePath, buffer, { flag: 'w' }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), USB_TIMEOUT_MS))
    ]);
    return { ok: true, sent_bytes: buffer.length };
  } catch (err) {
    if (err.code === 'ETIMEDOUT') return fail('USB_TIMEOUT', `Device ${devicePath} did not accept the job in time.`);
    return fail('USB_SPOOL_FAILED', `Could not write to ${devicePath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
/** Parse `Get-Printer | ConvertTo-Json` output: a single object, an array, or nothing. */
export function parseWindowsPrinterList(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(data) ? data : [data];
  return rows
    .filter(r => r && typeof r.Name === 'string' && isValidSystemPrinterName(r.Name))
    .map(r => ({ name: r.Name, driver: r.DriverName || null, port: r.PortName || null }));
}

export function parseLpstatList(stdout) {
  return String(stdout || '').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && isValidSystemPrinterName(l))
    .map(name => ({ name, driver: null, port: null }));
}

/** Printer queues the OS knows about, for the "pick your printer" step in setup. */
export async function listSystemPrinters() {
  const platform = usbDeps.platform();
  if (platform === 'win32') {
    const r = await usbDeps.run('powershell.exe', POWERSHELL_ARGS(WINDOWS_LIST_SCRIPT));
    if (r.code !== 0) return { ok: false, platform, printers: [], error: cleanStderr(r.stderr) || 'Could not list printers.' };
    return { ok: true, platform, printers: parseWindowsPrinterList(r.stdout) };
  }
  if (platform === 'linux' || platform === 'darwin') {
    const r = await usbDeps.run('lpstat', ['-e']);
    if (r.code !== 0) return { ok: false, platform, printers: [], error: cleanStderr(r.stderr) || 'Could not list printers (is CUPS installed?).' };
    return { ok: true, platform, printers: parseLpstatList(r.stdout) };
  }
  return { ok: false, platform, printers: [], error: `USB printing is not supported on ${platform}.` };
}
