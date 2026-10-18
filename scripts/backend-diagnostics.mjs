/** Child stderr is untrusted: only complete allowlisted health lines leave this boundary. */
export const backendDiagnostics = (report) => {
  let line = "";
  let discarded = false;
  let unknownReported = false;
  let forwarded = 0;
  const boundedReport = (message) => {
    const record =
      forwarded < 128
        ? message
        : forwarded === 128
          ? "Voice backend diagnostics suppressed after 128 records."
          : undefined;
    forwarded += 1;
    if (record !== undefined) {
      try {
        report(record);
      } catch {
        // Reporting must never turn child diagnostics into a launcher failure.
      }
    }
  };
  const emit = () => {
    if (
      /^Balabol backend (configuration|runtime) failed$/u.test(line) ||
      /^Operation audit (write failed|queue overflow|record too large|projection failed)$/u.test(line) ||
      /^Operation audit shutdown deadline exceeded; pending=\d{1,9}$/u.test(line)
    )
      boundedReport(line);
    else if ((line || discarded) && !unknownReported) {
      unknownReported = true;
      boundedReport("Voice backend emitted an unclassified diagnostic; raw contents suppressed.");
    }
    line = "";
    discarded = false;
  };
  return {
    write(chunk) {
      for (const byte of chunk) {
        if (byte === 10) emit();
        else if (!discarded && line.length < 256) line += String.fromCharCode(byte);
        else {
          discarded = true;
          line = "";
        }
      }
    },
    finish() {
      if (line || discarded) emit();
    },
  };
};
export const backendExitDiagnostic = (code, signal) => {
  const safeSignal = ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS"].includes(signal)
    ? signal
    : signal === null
      ? "none"
      : "other";
  return `Voice backend exited: code=${Number.isInteger(code) ? code : "none"}, signal=${safeSignal}.`;
};
