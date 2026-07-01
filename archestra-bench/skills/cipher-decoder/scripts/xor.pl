#!/usr/bin/perl
# Single-byte XOR decoder for the `xor` scheme: reads a hex blob and XORs every byte with --key.
# This is NOT the chained-hex cipher -- on a chained-hex blob it returns garbage. See the params file
# for which scheme a given blob uses.
use strict;
use warnings;

my ($key, $hex);
my @args = @ARGV;
while (@args) {
    my $a = shift @args;
    if    ($a eq '--key')          { $key = shift @args; }
    elsif ($a =~ /\A--key=(.*)\z/) { $key = $1; }
    else                           { $hex = $a; }
}
defined $hex or die "usage: xor.pl --key <k> <hex>\n";
defined $key or die "missing --key (see the params file)\n";

my @bytes = map { hex } unpack '(A2)*', $hex;
print join '', map { chr(($_ ^ $key) & 255) } @bytes;
