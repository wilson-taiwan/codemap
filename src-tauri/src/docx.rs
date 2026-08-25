//! Pulling plain text out of a Word document.
//!
//! Transcription services deliver `.docx` more often than anything else, so
//! refusing it would push the most common professional workflow back through a
//! manual copy-and-paste — precisely the step where a transcript picks up
//! stray formatting and stops matching the other coder's copy byte for byte.
//!
//! A `.docx` is a zip containing `word/document.xml`. The text lives in `<w:t>`
//! runs, grouped into `<w:p>` paragraphs. That is all this needs to know: the
//! output is handed to the same speaker-label parser that reads Otter and Rev
//! exports, so the goal is faithful plain text, not fidelity to Word.
//!
//! Scanned by hand rather than with an XML crate. The structure being read is
//! two tags deep, the input is a file the user chose, and a parser dependency
//! would be a larger surface than the thing it parses.

use std::io::Read;

/// Extract the document's text, one paragraph per line.
pub fn extract_text(bytes: &[u8]) -> Result<String, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Not a readable .docx file: {e}"))?;

    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| {
            "This .docx has no word/document.xml — it may be a .doc renamed, \
             or the file may be damaged."
                .to_string()
        })?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Could not read the document body: {e}"))?;

    Ok(xml_to_text(&xml))
}

/// Turn WordprocessingML into paragraphs of plain text.
fn xml_to_text(xml: &str) -> String {
    let bytes = xml.as_bytes();
    let mut out = String::with_capacity(xml.len() / 4);
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(close) = xml[i..].find('>').map(|o| i + o) else {
            break;
        };
        let tag = &xml[i + 1..close];
        // The closing slash has to come off *before* splitting, or `</w:p>`
        // yields an empty name and every paragraph break is silently dropped.
        let is_closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");

        match (is_closing, name) {
            // A text run: everything up to its closing tag is literal content.
            (false, "w:t") if !tag.ends_with('/') => {
                let start = close + 1;
                if let Some(end) = xml[start..].find("</w:t>").map(|o| start + o) {
                    out.push_str(&decode_entities(&xml[start..end]));
                    i = end + "</w:t>".len();
                    continue;
                }
            }
            // Paragraph and explicit line breaks are the only structure that
            // matters downstream — the speaker parser works line by line.
            (true, "w:p") => out.push('\n'),
            (false, "w:br" | "w:cr") => out.push('\n'),
            (false, "w:tab") => out.push('\t'),
            _ => {}
        }
        i = close + 1;
    }

    // Word writes a great many empty paragraphs; collapse runs of blank lines
    // to one so the parser's "blank line ends a turn" rule stays meaningful.
    let mut text = String::with_capacity(out.len());
    let mut blanks = 0;
    for line in out.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        text.push_str(line.trim_end());
        text.push('\n');
    }
    text.trim_start_matches('\n').to_string()
}

fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // Ampersand last, or "&amp;lt;" would decode twice into "<".
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn docx_with(body: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            zip.start_file::<_, ()>("word/document.xml", Default::default())
                .unwrap();
            zip.write_all(
                format!(r#"<?xml version="1.0"?><w:document><w:body>{body}</w:body></w:document>"#)
                    .as_bytes(),
            )
            .unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    fn para(text: &str) -> String {
        format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
    }

    #[test]
    fn reads_a_transcript_out_of_a_word_file() {
        let doc = docx_with(&format!(
            "{}{}",
            para("Ada: how was the party"),
            para("P07: exhausting, honestly")
        ));
        let text = extract_text(&doc).unwrap();
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            vec!["Ada: how was the party", "P07: exhausting, honestly"]
        );
    }

    #[test]
    fn joins_runs_within_one_paragraph() {
        // Word splits a sentence across runs whenever formatting changes, so a
        // single spoken line routinely arrives as several <w:t> elements.
        let doc = docx_with(
            "<w:p><w:r><w:t>I rehearse </w:t></w:r><w:r><w:t>everything</w:t></w:r></w:p>",
        );
        assert_eq!(extract_text(&doc).unwrap().trim(), "I rehearse everything");
    }

    #[test]
    fn decodes_entities_without_decoding_twice() {
        let doc = docx_with(&para("she said &quot;fine&quot; &amp; left &amp;lt;"));
        assert_eq!(
            extract_text(&doc).unwrap().trim(),
            r#"she said "fine" & left &lt;"#
        );
    }

    #[test]
    fn collapses_words_empty_paragraphs() {
        let doc = docx_with(&format!(
            "{}{}{}{}{}",
            para("Ada: first"),
            para(""),
            para(""),
            para(""),
            para("P07: second")
        ));
        let text = extract_text(&doc).unwrap();
        assert_eq!(
            text.matches("\n\n").count(),
            1,
            "runs of empty paragraphs must collapse to one blank line: {text:?}"
        );
    }

    #[test]
    fn a_line_break_inside_a_paragraph_starts_a_new_line() {
        let doc =
            docx_with("<w:p><w:r><w:t>Ada  00:12</w:t><w:br/><w:t>how was it</w:t></w:r></w:p>");
        assert_eq!(
            extract_text(&doc).unwrap().lines().collect::<Vec<_>>(),
            vec!["Ada  00:12", "how was it"]
        );
    }

    #[test]
    fn a_file_that_is_not_a_docx_is_refused_clearly() {
        let err = extract_text(b"this is a plain text file").unwrap_err();
        assert!(err.contains("Not a readable .docx"), "{err}");
    }
}
