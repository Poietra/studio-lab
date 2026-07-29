use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

pub(crate) const FONT_BYTES_V1: &[u8] = include_bytes!("../assets/NewCMMath-Regular.otf");

/// A one-source, one-font Typst world with no external loading capabilities.
pub(crate) struct HermeticMathWorldV1 {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    font: Font,
    source: Source,
}

impl HermeticMathWorldV1 {
    pub(crate) fn new(source_text: String) -> Option<Self> {
        let font = Font::new(Bytes::new(FONT_BYTES_V1), 0)?;
        let book = FontBook::from_fonts([&font]);
        Some(Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            font,
            source: Source::detached(source_text),
        })
    }
}

fn not_found(id: FileId) -> FileError {
    FileError::NotFound(id.vpath().get_without_slash().into())
}

impl World for HermeticMathWorldV1 {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.source.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source.id() {
            Ok(self.source.clone())
        } else {
            Err(not_found(id))
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        Err(not_found(id))
    }

    fn font(&self, index: usize) -> Option<Font> {
        (index == 0).then(|| self.font.clone())
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::MATHTEX_FONT_DIGEST_V1;

    #[test]
    fn embedded_font_matches_the_pinned_digest() {
        assert_eq!(
            format!("{:x}", Sha256::digest(FONT_BYTES_V1)),
            MATHTEX_FONT_DIGEST_V1
        );
    }
}
