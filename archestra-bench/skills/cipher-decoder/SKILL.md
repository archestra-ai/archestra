---
name: cipher-decoder
description: Decode ciphertext produced by the in-house chained-hex cipher. Use when a task hands you a hex-encoded blob and asks for its plaintext; run the bundled decoder rather than guessing the scheme.
---

# Cipher decoder

This skill decodes the in-house cipher used for archestra benchmark blobs. The scheme is bespoke —
it cannot be recovered from the ciphertext alone — so always decode with the bundled script.

The ciphertext is a lowercase hex string. Run the decoder with the hex as its first argument; it
prints the decoded plaintext to stdout (no trailing newline):

```
perl /skills/cipher-decoder/scripts/decode.pl <hex-ciphertext>
```

For example, if the blob is `4a7e...`, run `perl /skills/cipher-decoder/scripts/decode.pl 4a7e...`
and read the plaintext from stdout.
