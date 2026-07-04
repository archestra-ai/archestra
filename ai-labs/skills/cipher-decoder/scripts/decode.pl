#!/usr/bin/perl
# Decode the in-house chained-hex cipher. Pure perl-base builtins only (no CPAN modules), so it runs
# on the sandbox base image. The two rotor constants are NOT baked into this script -- pass them with
# --mult and --add (their values for each scheme are recorded in the skill's params file). Reads the hex
# ciphertext from the first non-flag CLI argument and prints the decoded plaintext to stdout. Inverse
# of the encoder in tasks/decode-cipher/expected/build_fixture.py.
use strict;
use warnings;

my ($mult, $add, $hex);
my @args = @ARGV;
while (@args) {
    my $a = shift @args;
    if    ($a eq '--mult')          { $mult = shift @args; }
    elsif ($a eq '--add')           { $add  = shift @args; }
    elsif ($a =~ /\A--mult=(.*)\z/) { $mult = $1; }
    elsif ($a =~ /\A--add=(.*)\z/)  { $add  = $1; }
    else                            { $hex  = $a; }
}

defined $hex or die "usage: decode.pl --mult <m> --add <a> <hex-ciphertext>\n";
defined $mult && defined $add
    or die "missing rotor params; pass --mult and --add (their values are in the params file)\n";
$mult =~ /\A\d+\z/ && $add =~ /\A\d+\z/ or die "rotor params must be integers\n";
$hex =~ /\A[0-9a-fA-F]+\z/ or die "ciphertext must be hexadecimal\n";
length($hex) % 2 == 0 or die "hex length must be even\n";

my @cipher = map { hex } unpack '(A2)*', $hex;

my $state = 0;
my $prev  = 0;
my $out   = '';
for my $i (0 .. $#cipher) {
    $state = ($state * $mult + $add + $i) & 255;
    my $p = ($cipher[$i] - $state - $prev) & 255;
    $out .= chr($p);
    $prev = $p;
}

print $out;
