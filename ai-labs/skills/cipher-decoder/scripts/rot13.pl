#!/usr/bin/perl
# ROT13 decoder for the `rot13` scheme: rotates ASCII letters by 13. Operates on text, not hex --
# this is NOT the chained-hex cipher and will not recover a hex blob's plaintext. See the params file
# for which scheme a given blob uses.
use strict;
use warnings;

my $text = $ARGV[0];
defined $text or die "usage: rot13.pl <text>\n";
$text =~ tr/A-Za-z/N-ZA-Mn-za-m/;
print $text;
