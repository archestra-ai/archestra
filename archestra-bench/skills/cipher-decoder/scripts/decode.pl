#!/usr/bin/perl
# Decode the in-house chained-hex cipher. Pure perl-base builtins only (no CPAN modules), so it runs
# on the sandbox base image. Reads the hex ciphertext from the first CLI argument and prints the
# decoded plaintext to stdout. Inverse of the encoder in
# tasks/decode-cipher/expected/build_fixture.py.
use strict;
use warnings;

my $hex = $ARGV[0];
defined $hex or die "usage: decode.pl <hex-ciphertext>\n";
$hex =~ /\A[0-9a-fA-F]+\z/ or die "ciphertext must be hexadecimal\n";
length($hex) % 2 == 0 or die "hex length must be even\n";

my @cipher = map { hex } unpack '(A2)*', $hex;

my $state = 0;
my $prev  = 0;
my $out   = '';
for my $i (0 .. $#cipher) {
    $state = ($state * 73 + 41 + $i) & 255;
    my $p = ($cipher[$i] - $state - $prev) & 255;
    $out .= chr($p);
    $prev = $p;
}

print $out;
