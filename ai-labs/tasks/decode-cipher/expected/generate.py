#!/usr/bin/env python3
"""Regenerate the decode-cipher fixtures: the hex ciphertext staged to the agent and the plaintext
ground truth read by the verifier.

This is the encoder; `skills/cipher-decoder/scripts/decode.pl` is the decoder. They must stay exact
inverses (the round-trip is checked in CI/dev by running both). Deterministic: no RNG, no clock.

Run: `uv run ai-labs/tasks/decode-cipher/expected/generate.py`
Writes `../inputs/cipher.txt` and `./plaintext.txt`, then verifies its own round-trip.
"""

from pathlib import Path

# The secret message. ASCII only; chosen so it cannot be guessed from the ciphertext.
PLAINTEXT = "Ship the Q3 retro deck to Dana by 18:00 sharp; the vault code is ARCH-7741 (do not share)."


def encode(plaintext: str) -> str:
    data = plaintext.encode("ascii")
    state = 0
    prev = 0
    out: list[str] = []
    for i, p in enumerate(data):
        state = (state * 73 + 41 + i) & 255
        c = (p + state + prev) & 255
        out.append(f"{c:02x}")
        prev = p
    return "".join(out)


def decode(hex_text: str) -> str:
    cipher = bytes.fromhex(hex_text)
    state = 0
    prev = 0
    out = bytearray()
    for i, c in enumerate(cipher):
        state = (state * 73 + 41 + i) & 255
        p = (c - state - prev) & 255
        out.append(p)
        prev = p
    return out.decode("ascii")


def main() -> None:
    expected_dir = Path(__file__).resolve().parent
    task_dir = expected_dir.parent
    cipher_hex = encode(PLAINTEXT)
    assert decode(cipher_hex) == PLAINTEXT, "encoder/decoder round-trip mismatch"

    (task_dir / "inputs").mkdir(exist_ok=True)
    (task_dir / "inputs" / "cipher.txt").write_text(cipher_hex, encoding="ascii")
    (expected_dir / "plaintext.txt").write_text(PLAINTEXT, encoding="ascii")
    print(f"wrote {len(cipher_hex)} hex chars; plaintext {len(PLAINTEXT)} chars")


if __name__ == "__main__":
    main()
