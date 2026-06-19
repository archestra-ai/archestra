---
name: cipher-decoder
description: Decode an encoded message using the bundled cipher scripts. Use when handed a hex-encoded or otherwise scrambled blob and asked for its plaintext; run the scripts rather than reasoning about the bytes by hand.
---

# Cipher decoder

These ciphers are bespoke — a scheme cannot be recovered from the ciphertext alone — so always decode
with the bundled scripts rather than guessing the bytes by hand.

`scripts/` holds decoders for several schemes (each script's header says which one it handles), and
the per-scheme key constants live in the params file (`parameters.txt`), one row per scheme. The
scripts do not hard-code those constants — pass them on the command line.

A blob decodes cleanly under exactly one scheme: the right script and row print readable text, while
every other combination runs without error but prints garbage. If you don't already know the scheme,
work through the rows and keep the output that reads as plain language. The hex decoder runs as:

```
perl /skills/cipher-decoder/scripts/decode.pl --mult <m> --add <a> <hex-ciphertext>
```

The decoder prints the plaintext to stdout (no trailing newline).
