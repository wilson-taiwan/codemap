#!/usr/bin/env python3
"""
Summarize macOS .ips / .crash crash reports into a clean human-readable format.
Never prints private user data or extraneous memory dumps.
"""
import sys
import json
import os

def summarize_crash(file_path):
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}", file=sys.stderr)
        return

    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    print(f"\n================ CRASH REPORT SUMMARY ================")
    print(f"Report File: {os.path.basename(file_path)}")

    # Try parsing as JSON (.ips format on modern macOS)
    try:
        data = json.loads(content)
        app_name = data.get("app_name", "Unknown")
        bundle_id = data.get("bundleID", "Unknown")
        app_version = data.get("app_version", "Unknown")
        os_version = data.get("os_version", "Unknown")
        capture_time = data.get("captureTime", "Unknown")
        exception = data.get("exception", {})
        exc_type = exception.get("type", "Unknown")
        exc_signal = exception.get("signal", "Unknown")

        print(f"Application: {app_name} ({bundle_id}) version {app_version}")
        print(f"OS Version: {os_version}")
        print(f"Timestamp: {capture_time}")
        print(f"Exception: Type={exc_type}, Signal={exc_signal}")

        threads = data.get("threads", [])
        faulting_thread = data.get("faultingThread")
        if faulting_thread is not None and faulting_thread < len(threads):
            t = threads[faulting_thread]
            print(f"\nCrashed Thread ({faulting_thread}) Backtrace:")
            for idx, frame in enumerate(t.get("frames", [])[:15]):
                symbol = frame.get("symbol", f"0x{frame.get('imageOffset', 0):x}")
                image = frame.get("imageIndex", "")
                print(f"  #{idx:02d} {symbol} (image: {image})")
        print("======================================================\n")
        return
    except Exception:
        pass

    # Legacy text-based crash log parser (.crash)
    lines = content.splitlines()
    for line in lines[:30]:
        if any(line.startswith(prefix) for prefix in [
            "Process:", "Identifier:", "Version:", "Code Type:", "OS Version:",
            "Exception Type:", "Exception Codes:", "Exception Note:", "Crashed Thread:"
        ]):
            print(line)

    print("======================================================\n")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: summarize-macos-crash.py <crash_file_path>", file=sys.stderr)
        sys.exit(1)
    summarize_crash(sys.argv[1])
