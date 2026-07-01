#!/usr/bin/perl
# Caesar-shift decoder for the `caesar` scheme: reads a hex blob and subtracts a fixed --shift from
# every byte. This is NOT the chained-hex cipher -- on a chained-hex blob it returns garbage. See the
# params file for which scheme a given blob uses.
use strict;
use warnings;

my ($shift, $hex);
my @args = @ARGV;
while (@args) {
    my $a = shift @args;
    if    ($a eq '--shift')          { $shift = shift @args; }
    elsif ($a =~ /\A--shift=(.*)\z/) { $shift = $1; }
    else                             { $hex = $a; }
}
defined $hex   or die "usage: caesar.pl --shift <n> <hex>\n";
defined $shift or die "missing --shift (see the params file)\n";

my @bytes = map { hex } unpack '(A2)*', $hex;
print join '', map { chr(($_ - $shift) & 255) } @bytes;
