use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;

pub fn validate_pdf_output(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("PDF output file does not exist".into());
    }
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let len = metadata.len();
    if len < 8192 {
        return Err(format!(
            "PDF output is too small ({} bytes, expected >= 8192 bytes)",
            len
        ));
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 5];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header != b"%PDF-" {
        return Err("File is missing %PDF- header".into());
    }

    use std::io::Seek;
    let tail_len = std::cmp::min(len, 1024) as usize;
    file.seek(std::io::SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| e.to_string())?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;

    let tail_str = String::from_utf8_lossy(&tail);
    if !tail_str.contains("startxref") || !tail_str.contains("%%EOF") {
        return Err("PDF is missing trailing startxref or %%EOF marker".into());
    }

    Ok(())
}

pub fn render_report_pdf(html: &str, out_path: &Path) -> Result<(), String> {
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create tempdir: {e}"))?;
    let html_path = temp_dir.path().join("report.html");
    fs::write(&html_path, html).map_err(|e| format!("Failed to write temp html: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        let swift_script = r#"
import Cocoa
import WebKit

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: render_pdf <html_path> <out_pdf_path>\n", stderr)
    exit(1)
}

let htmlPath = CommandLine.arguments[1]
let outPath = CommandLine.arguments[2]
let htmlUrl = URL(fileURLWithPath: htmlPath)

class PDFRenderer: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let outUrl: URL

    init(outUrl: URL) {
        self.outUrl = outUrl
        let config = WKWebViewConfiguration()
        self.webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 816, height: 1056), configuration: config)
        super.init()
        self.webView.navigationDelegate = self
    }

    func render(url: URL) {
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            let pdfConfig = WKPDFConfiguration()
            self.webView.createPDF(configuration: pdfConfig) { result in
                switch result {
                case .success(let data):
                    do {
                        try data.write(to: self.outUrl)
                        CFRunLoopStop(CFRunLoopGetMain())
                        exit(0)
                    } catch {
                        fputs("Failed to write PDF: \(error)\n", stderr)
                        CFRunLoopStop(CFRunLoopGetMain())
                        exit(2)
                    }
                case .failure(let error):
                    fputs("Failed to create PDF: \(error)\n", stderr)
                    CFRunLoopStop(CFRunLoopGetMain())
                    exit(3)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fputs("Navigation failed: \(error)\n", stderr)
        CFRunLoopStop(CFRunLoopGetMain())
        exit(4)
    }
}

let renderer = PDFRenderer(outUrl: URL(fileURLWithPath: outPath))
renderer.render(url: htmlUrl)
CFRunLoopRun()
"#;
        let script_path = temp_dir.path().join("render.swift");
        fs::write(&script_path, swift_script)
            .map_err(|e| format!("Failed to write render script: {e}"))?;

        let output = Command::new("swift")
            .arg(&script_path)
            .arg(&html_path)
            .arg(out_path)
            .output()
            .map_err(|e| format!("Failed to execute macOS PDF generator (swift): {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("macOS PDF generator failed: {stderr}"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let edge_paths = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];
        let mut executed = false;
        for edge in &edge_paths {
            if Path::new(edge).exists() {
                let status = Command::new(edge)
                    .arg("--headless")
                    .arg("--disable-gpu")
                    .arg("--run-all-compositor-stages-before-draw")
                    .arg(format!("--print-to-pdf={}", out_path.display()))
                    .arg(html_path.to_string_lossy().as_ref())
                    .status();
                if let Ok(s) = status {
                    if s.success() {
                        executed = true;
                        break;
                    }
                }
            }
        }
        if !executed {
            return Err(
                "Windows PDF generator: Microsoft Edge not found or failed to print PDF".into(),
            );
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err("PDF generation is not supported on this platform".into());
    }

    validate_pdf_output(out_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn pdf_validation_rejects_small_or_headerless_output() {
        let dir = tempdir().unwrap();

        // 1. Missing file
        let missing = dir.path().join("missing.pdf");
        assert!(validate_pdf_output(&missing).is_err());

        // 2. Small file (< 8192 bytes)
        let small = dir.path().join("small.pdf");
        fs::write(&small, b"%PDF-1.4\nsmall content\nstartxref\n123\n%%EOF").unwrap();
        assert!(validate_pdf_output(&small).is_err());

        // 3. Headerless file
        let headerless = dir.path().join("headerless.pdf");
        let mut buf = vec![b'A'; 9000];
        let suffix = b"\nstartxref\n123\n%%EOF";
        let end_idx = buf.len() - suffix.len();
        buf[end_idx..].copy_from_slice(suffix);
        fs::write(&headerless, &buf).unwrap();
        assert!(validate_pdf_output(&headerless).is_err());

        // 4. Missing trailer markers
        let no_trailer = dir.path().join("no_trailer.pdf");
        let mut buf2 = vec![b'A'; 9000];
        buf2[0..5].copy_from_slice(b"%PDF-");
        fs::write(&no_trailer, &buf2).unwrap();
        assert!(validate_pdf_output(&no_trailer).is_err());

        // 5. Valid header, size, and trailer
        let valid = dir.path().join("valid.pdf");
        buf2[end_idx..].copy_from_slice(suffix);
        fs::write(&valid, &buf2).unwrap();
        assert!(validate_pdf_output(&valid).is_ok());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn render_report_pdf_creates_valid_pdf() {
        let dir = tempdir().unwrap();
        let out_pdf = dir.path().join("out.pdf");
        let html = r#"
            <!DOCTYPE html>
            <html>
            <head><title>Test Report</title></head>
            <body>
                <h1>Codemap Qualitative Study Report</h1>
                <p>Testing real WebKit PDF generation.</p>
            </body>
            </html>
        "#;
        let res = render_report_pdf(html, &out_pdf);
        assert!(res.is_ok(), "PDF generation failed: {:?}", res);
        assert!(out_pdf.exists());
        assert!(validate_pdf_output(&out_pdf).is_ok());
    }
}
