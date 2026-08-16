use std::io::{self, Write};

/// Collects bytes without exceeding a caller-owned limit. A rejected write is
/// atomic: no prefix of that write is retained.
#[derive(Debug)]
pub(crate) struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    overflowed: bool,
}

impl BoundedWriter {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            overflowed: false,
        }
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) const fn overflowed(&self) -> bool {
        self.overflowed
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let Some(next_length) = self.bytes.len().checked_add(buffer.len()) else {
            self.overflowed = true;
            return Err(io::Error::other("bounded output length overflow"));
        };
        if next_length > self.limit {
            self.overflowed = true;
            return Err(io::Error::other("bounded output exceeds limit"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_write_keeps_the_previous_complete_prefix() {
        let mut writer = BoundedWriter::new(5);
        writer.write_all(b"1234").unwrap();
        assert!(writer.write_all(b"56").is_err());
        assert!(writer.overflowed());
        assert_eq!(writer.into_bytes(), b"1234");
    }
}
