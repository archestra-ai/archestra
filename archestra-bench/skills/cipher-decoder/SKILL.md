---
name: cipher-decoder
description: Decode ciphertext produced by the in-house chained-hex cipher. Use when a task hands you a hex-encoded blob and asks for its plaintext; run the bundled decoder rather than guessing the scheme.
---

# Cipher decoder

This skill decodes the in-house cipher used for archestra benchmark blobs. The scheme is bespoke —
it cannot be recovered from the ciphertext alone — so always decode with the bundled scripts.

`scripts/` holds decoders for several ciphers we have seen (each script's header says which scheme it
handles). The archestra benchmark blobs use the **chained-hex** scheme, decoded by `decode.pl`. The
other scripts are for unrelated blobs and will return garbage here.

The decoders do not hard-code their key constants — those live in the skill's params file, one row
per scheme. Read the `chained-hex` row, then run the decoder with the ciphertext plus its rotor params:

```
perl /skills/cipher-decoder/scripts/decode.pl --mult <m> --add <a> <hex-ciphertext>
```

The ciphertext is a lowercase hex string; the decoder prints the plaintext to stdout (no trailing
newline). Without the correct rotor params from the params file it errors or returns garbage.
