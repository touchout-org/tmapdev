// braille-ueb.js — Unified English Braille (UEB) forward translation for
// DotTMAP's message display only (see tmap spec.md § Braille translator).
// Street labels always use 8-dot computer braille via NABCC in app.js --
// this module is never used for those.
//
// Cell/dot-bit convention matches app.js's own NABCC table: bit0=dot1,
// bit1=dot2, ..., bit5=dot6. This module only ever produces 6-dot cells
// (bits 6/7 always 0), since UEB Grade 1/2 are 6-dot literary braille
// codes, distinct from the 8-dot computer braille NABCC provides.
//
// Data below is derived from liblouis (https://github.com/liblouis/liblouis,
// LGPL 2.1+): tables/latinLetterDef6Dots.uti (letters), tables/
// en-ueb-chardefs.uti (digits, number sign, capital sign, punctuation),
// and tables/en-ueb-g2.ctb (Grade 2 contractions). Not a vendored copy of
// those files -- hand-extracted down to just the forward-translation-
// relevant, position-based subset (see tmap spec.md for the full
// methodology and why the more context-dependent liblouis rules --
// mainly its "match"-opcode rules -- were excluded).

// § Grade 1 — a-z, lowercase dot patterns. Capitals are handled by
// prefixing UEB_CAPSIGN, not a separate table (see translateGrade1).
export const UEB_LETTERS = {
  "a": 1, "b": 3, "c": 9, "d": 25, "e": 17, "f": 11, "g": 27,
  "h": 19, "i": 10, "j": 26, "k": 5, "l": 7, "m": 13, "n": 29,
  "o": 21, "p": 15, "q": 31, "r": 23, "s": 14, "t": 30, "u": 37,
  "v": 39, "w": 58, "x": 45, "y": 61, "z": 53,
};

// § Grade 1 — 0-9, the classic UEB numeric-mode digit shapes (the same
// dot patterns as letters a-j) -- used only after UEB_NUMSIGN.
export const UEB_DIGITS = {
  "0": 26, "1": 1, "2": 3, "3": 9, "4": 25,
  "5": 17, "6": 11, "7": 27, "8": 19, "9": 10,
};

export const UEB_NUMSIGN = 60; // dots 3456
export const UEB_CAPSIGN = 32; // dot 6

// § Grade 1 — punctuation actually used in this app's message-display
// text today (checked against every setMessage() call site in app.js).
// Each value is an array of 1+ cells (most punctuation is a single cell;
// '?' and the ellipsis need more than one). Space is a blank cell ([0]),
// not omitted, so it still occupies a character position on the 20-cell
// display.
export const UEB_PUNCTUATION = {
  " ": [0],
  ".": [50],
  ",": [2],
  "'": [4],
  "-": [36],
  "…": [50, 50, 50],
  ":": [18],
  ";": [6],
  "&": [8, 47],
  "=": [16, 54],
  "!": [22],
  "?": [48, 38],
};

// § Grade 2 — the 23 "alphabetic wordsigns" (UEB §10.1: as, but, can, do,
// every, from, go, have, it, just, knowledge, like, more, not, people,
// quite, rather, so, that, us, very, will, you) -- standalone whole-word
// signs, kept as their own category since liblouis only exposes them for
// forward translation via its context-dependent "match" opcode (to
// additionally handle optional 'd/'ll/re/'s/'t/'ve suffixes, which this
// app's message text never needs), not a plain word-position opcode.
export const UEB_WORDSIGN_RULES = [
  { text: "as", position: "alphabetic-wordsign", cells: [53] },
  { text: "but", position: "alphabetic-wordsign", cells: [3] },
  { text: "can", position: "alphabetic-wordsign", cells: [9] },
  { text: "do", position: "alphabetic-wordsign", cells: [25] },
  { text: "every", position: "alphabetic-wordsign", cells: [17] },
  { text: "from", position: "alphabetic-wordsign", cells: [11] },
  { text: "go", position: "alphabetic-wordsign", cells: [27] },
  { text: "have", position: "alphabetic-wordsign", cells: [19] },
  { text: "it", position: "alphabetic-wordsign", cells: [45] },
  { text: "just", position: "alphabetic-wordsign", cells: [26] },
  { text: "knowledge", position: "alphabetic-wordsign", cells: [5] },
  { text: "like", position: "alphabetic-wordsign", cells: [7] },
  { text: "more", position: "alphabetic-wordsign", cells: [13] },
  { text: "not", position: "alphabetic-wordsign", cells: [29] },
  { text: "people", position: "alphabetic-wordsign", cells: [15] },
  { text: "quite", position: "alphabetic-wordsign", cells: [31] },
  { text: "rather", position: "alphabetic-wordsign", cells: [23] },
  { text: "so", position: "alphabetic-wordsign", cells: [14] },
  { text: "that", position: "alphabetic-wordsign", cells: [30] },
  { text: "us", position: "alphabetic-wordsign", cells: [37] },
  { text: "very", position: "alphabetic-wordsign", cells: [39] },
  { text: "will", position: "alphabetic-wordsign", cells: [58] },
  { text: "you", position: "alphabetic-wordsign", cells: [61] },
];

// § Grade 2 — the "dot 5" lower signs: two-cell whole/part-word
// contractions, dot 5 alone (16) followed by a single letter's own
// plain cell. "always" position -- unlike the alphabetic wordsigns
// above, these fire wherever the text occurs, not just as a standalone
// whole word (e.g. "father" contracts the same way inside "cofather"
// as it does alone). Confirmed against the pre-existing "cofather"/
// "coname"/etc. entries already extracted into UEB_G2_RULES below,
// which already use these exact two-cell sequences for their "father"/
// "name" portions -- e.g. "cofather" = c, o, [dot5, f].
//
// dot5+k is "know", not "knowledge" -- that's the single-letter
// alphabetic wordsign above (cells: [5], whole-word only). No collision
// between the two: different text, so no priority question to resolve.
const UEB_DOT5_SIGN_RULES = [
  { text: "day", position: "always", cells: [16, 25] },
  { text: "ever", position: "always", cells: [16, 17] },
  { text: "father", position: "always", cells: [16, 11] },
  { text: "here", position: "always", cells: [16, 19] },
  { text: "know", position: "always", cells: [16, 5] },
  { text: "lord", position: "always", cells: [16, 7] },
  { text: "mother", position: "always", cells: [16, 13] },
  { text: "name", position: "always", cells: [16, 29] },
  { text: "one", position: "always", cells: [16, 21] },
  { text: "part", position: "always", cells: [16, 15] },
  { text: "question", position: "always", cells: [16, 31] },
  { text: "right", position: "always", cells: [16, 23] },
  { text: "some", position: "always", cells: [16, 14] },
  { text: "time", position: "always", cells: [16, 30] },
  { text: "under", position: "always", cells: [16, 37] },
  { text: "work", position: "always", cells: [16, 58] },
  { text: "young", position: "always", cells: [16, 61] },
];

// § Grade 2 — the 640 contractions expressible as a pure word-position
// rule (opcodes always/word/begword/endword/midword/midendword/sufword),
// extracted from liblouis's en-ueb-g2.ctb. cells: null means "use Grade 1
// (plain letter) spelling for this exact match" -- liblouis's '=' dots
// value, used to override/suppress a contraction for specific words
// where the general rule would otherwise misfire (e.g. exceptions to the
// "co" prefix sign).
export const UEB_G2_RULES = [
  { text: "and", position: "always", cells: [47] },
  { text: "for", position: "always", cells: [63] },
  { text: "of", position: "always", cells: [55] },
  { text: "ofor", position: "always", cells: [21, 63] },
  { text: "cofactor", position: "sufword", cells: null },
  { text: "cofather", position: "sufword", cells: [9, 21, 16, 11] },
  { text: "cofeatur", position: "sufword", cells: [9, 21, 11, 2, 30, 37, 23] },
  { text: "coferment", position: "sufword", cells: [9, 21, 11, 59, 48, 30] },
  { text: "cofield", position: "sufword", cells: null },
  { text: "cofight", position: "sufword", cells: [9, 21, 11, 10, 35, 30] },
  { text: "cofinal", position: "sufword", cells: [9, 21, 11, 20, 1, 7] },
  { text: "cofinance", position: "sufword", cells: [9, 21, 11, 20, 40, 17] },
  { text: "cofinancing", position: "sufword", cells: [9, 21, 11, 20, 1, 29, 9, 44] },
  { text: "cofound", position: "sufword", cells: [9, 21, 11, 40, 25] },
  { text: "cofunction", position: "sufword", cells: [9, 21, 11, 37, 29, 9, 48, 29] },
  { text: "filofax", position: "sufword", cells: [11, 10, 7, 21, 11, 1, 45] },
  { text: "insofar", position: "sufword", cells: [20, 14, 21, 11, 28] },
  { text: "portofino", position: "sufword", cells: [15, 21, 23, 30, 21, 11, 20, 21] },
  { text: "riboflavin", position: "sufword", cells: [23, 10, 3, 21, 11, 7, 1, 39, 20] },
  { text: "styrofoam", position: "sufword", cells: [12, 61, 23, 21, 11, 21, 1, 13] },
  { text: "turbofan", position: "sufword", cells: null },
  { text: "twofer", position: "sufword", cells: [30, 58, 21, 11, 59] },
  { text: "twofold", position: "sufword", cells: [30, 58, 21, 11, 21, 7, 25] },
  { text: "the", position: "always", cells: [46] },
  { text: "calisthenic", position: "sufword", cells: [9, 1, 7, 10, 14, 46, 29, 10, 9] },
  { text: "demosthenes", position: "sufword", cells: [25, 17, 13, 21, 14, 46, 29, 17, 14] },
  { text: "eratosthenes", position: "sufword", cells: [59, 1, 30, 21, 14, 46, 29, 17, 14] },
  { text: "esther", position: "sufword", cells: [17, 14, 46, 23] },
  { text: "hesther", position: "sufword", cells: [19, 17, 14, 46, 23] },
  { text: "motheaten", position: "sufword", cells: [13, 21, 57, 2, 30, 34] },
  { text: "northeast", position: "sufword", cells: [29, 21, 23, 57, 2, 12] },
  { text: "northesk", position: "sufword", cells: [29, 21, 23, 57, 17, 14, 5] },
  { text: "prostheses", position: "sufword", cells: [15, 23, 21, 14, 46, 14, 17, 14] },
  { text: "prosthesis", position: "sufword", cells: [15, 23, 21, 14, 46, 14, 10, 14] },
  { text: "prosthetic", position: "sufword", cells: [15, 23, 21, 14, 46, 30, 10, 9] },
  { text: "southeast", position: "sufword", cells: [14, 51, 57, 17, 1, 12] },
  { text: "southend", position: "sufword", cells: [14, 51, 57, 34, 25] },
  { text: "southesk", position: "sufword", cells: [14, 51, 57, 17, 14, 5] },
  { text: "strathearn", position: "sufword", cells: [12, 23, 1, 57, 17, 28, 29] },
  { text: "thence", position: "sufword", cells: [57, 48, 17] },
  { text: "with", position: "always", cells: [62] },
  { text: "ar", position: "always", cells: [28] },
  { text: "aright", position: "sufword", cells: [1, 16, 23] },
  { text: "indiarubber", position: "sufword", cells: [20, 25, 10, 1, 23, 37, 6, 59] },
  { text: "infrared", position: "sufword", cells: [20, 11, 23, 1, 23, 43] },
  { text: "ch", position: "always", cells: [33] },
  { text: "gchq", position: "sufword", cells: null },
  { text: "publicheart", position: "sufword", cells: [15, 37, 3, 7, 10, 9, 19, 17, 28, 30] },
  { text: "ed", position: "always", cells: [43] },
  { text: "basedow", position: "sufword", cells: [3, 1, 14, 17, 25, 42] },
  { text: "cliveden", position: "sufword", cells: [9, 7, 10, 39, 17, 25, 34] },
  { text: "daredevil", position: "sufword", cells: [25, 28, 17, 25, 17, 39, 10, 7] },
  { text: "doubleday", position: "sufword", cells: [25, 51, 3, 7, 17, 16, 25] },
  { text: "eyedrop", position: "sufword", cells: null },
  { text: "firedog", position: "sufword", cells: null },
  { text: "firedrak", position: "sufword", cells: null },
  { text: "firedrill", position: "sufword", cells: null },
  { text: "gwynedd", position: "sufword", cells: null },
  { text: "housedress", position: "sufword", cells: [19, 51, 14, 17, 25, 23, 17, 14, 14] },
  { text: "ingledew", position: "sufword", cells: [20, 27, 7, 17, 25, 17, 58] },
  { text: "kettledrum", position: "sufword", cells: [5, 17, 30, 30, 7, 17, 25, 23, 37, 13] },
  { text: "knuckleduster", position: "sufword", cells: [5, 29, 37, 9, 5, 7, 17, 25, 37, 12, 59] },
  { text: "piedish", position: "sufword", cells: [15, 10, 17, 25, 10, 41] },
  { text: "pinedrop", position: "sufword", cells: [15, 20, 17, 25, 23, 21, 15] },
  { text: "priedieu", position: "sufword", cells: null },
  { text: "rosedrop", position: "sufword", cells: null },
  { text: "shoreditch", position: "sufword", cells: [41, 21, 23, 17, 25, 10, 30, 33] },
  { text: "threedimension", position: "sufword", cells: [57, 23, 17, 17, 25, 10, 13, 34, 40, 29] },
  { text: "tonedeaf", position: "sufword", cells: [30, 16, 21, 25, 2, 11] },
  { text: "turtledove", position: "sufword", cells: [30, 37, 23, 30, 7, 17, 25, 21, 39, 17] },
  { text: "tweedledee", position: "sufword", cells: [30, 58, 17, 43, 7, 17, 25, 17, 17] },
  { text: "tweedledum", position: "sufword", cells: [30, 58, 17, 43, 7, 17, 25, 37, 13] },
  { text: "viced", position: "begword", cells: [39, 10, 9, 17, 25] },
  { text: "vinedress", position: "always", cells: [39, 20, 17, 25, 23, 17, 14, 14] },
  { text: "er", position: "always", cells: [59] },
  { text: "fireroom", position: "sufword", cells: null },
  { text: "forerunner", position: "sufword", cells: [63, 17, 23, 37, 29, 29, 59] },
  { text: "hedgerow", position: "sufword", cells: [19, 43, 27, 17, 23, 42] },
  { text: "homeroom", position: "sufword", cells: [19, 21, 13, 17, 23, 21, 21, 13] },
  { text: "horseradish", position: "sufword", cells: [19, 21, 23, 14, 17, 23, 1, 25, 10, 41] },
  { text: "spareribs", position: "sufword", cells: [14, 15, 28, 17, 23, 10, 3, 14] },
  { text: "stateroom", position: "sufword", cells: [12, 1, 30, 17, 23, 21, 21, 13] },
  { text: "storeroom", position: "sufword", cells: [12, 21, 23, 17, 23, 21, 21, 13] },
  { text: "viceregal", position: "sufword", cells: [39, 10, 9, 17, 23, 17, 27, 1, 7] },
  { text: "viceroy", position: "sufword", cells: [39, 10, 9, 17, 23, 21, 61] },
  { text: "castlereagh", position: "sufword", cells: [9, 1, 12, 7, 17, 23, 2, 35] },
  { text: "gh", position: "always", cells: [35] },
  { text: "cunnyngham", position: "sufword", cells: [9, 37, 29, 29, 61, 29, 27, 19, 1, 13] },
  { text: "froghop", position: "sufword", cells: null },
  { text: "hwangho", position: "sufword", cells: null },
  { text: "langhair", position: "sufword", cells: null },
  { text: "shanghai", position: "sufword", cells: [41, 1, 29, 27, 19, 1, 10] },
  { text: "senghor", position: "sufword", cells: [14, 34, 27, 19, 21, 23] },
  { text: "disingenuous", position: "sufword", cells: [50, 20, 27, 34, 37, 51, 14] },
  { text: "leningrad", position: "sufword", cells: [7, 34, 20, 27, 23, 1, 25] },
  { text: "seinglind", position: "sufword", cells: [14, 17, 20, 27, 7, 20, 25] },
  { text: "stalingrad", position: "sufword", cells: [12, 1, 7, 20, 27, 23, 1, 25] },
  { text: "vainglorious", position: "sufword", cells: [39, 1, 20, 27, 7, 21, 23, 10, 51, 14] },
  { text: "vainglory", position: "sufword", cells: [39, 1, 20, 27, 7, 21, 23, 61] },
  { text: "ou", position: "always", cells: [51] },
  { text: "ow", position: "always", cells: [42] },
  { text: "owork", position: "always", cells: [21, 16, 58] },
  { text: "cowinner", position: "sufword", cells: [9, 21, 58, 20, 29, 59] },
  { text: "kilowatt", position: "sufword", cells: [5, 10, 7, 21, 58, 1, 30, 30] },
  { text: "locoweed", position: "sufword", cells: [7, 21, 9, 21, 58, 17, 43] },
  { text: "monowheel", position: "sufword", cells: [13, 21, 29, 21, 49, 17, 17, 7] },
  { text: "noway", position: "sufword", cells: [29, 21, 58, 1, 61] },
  { text: "nowhere", position: "sufword", cells: [29, 21, 16, 49] },
  { text: "nowise", position: "sufword", cells: [29, 21, 58, 10, 14, 17] },
  { text: "sh", position: "always", cells: [41] },
  { text: "betshanger", position: "sufword", cells: [3, 17, 30, 14, 19, 1, 29, 27, 59] },
  { text: "bosham", position: "sufword", cells: null },
  { text: "chisholm", position: "sufword", cells: [33, 10, 14, 19, 21, 7, 13] },
  { text: "dachshund", position: "sufword", cells: [25, 1, 33, 14, 19, 37, 29, 25] },
  { text: "deshabille", position: "sufword", cells: [25, 17, 14, 19, 1, 3, 10, 7, 7, 17] },
  { text: "frederikshavn", position: "sufword", cells: [11, 23, 43, 59, 10, 5, 14, 19, 1, 39, 29] },
  { text: "gemshorn", position: "sufword", cells: null },
  { text: "goshawk", position: "sufword", cells: null },
  { text: "grasshopper", position: "sufword", cells: [27, 23, 1, 14, 14, 19, 21, 15, 15, 59] },
  { text: "grimsholm", position: "sufword", cells: null },
  { text: "hartshorn", position: "sufword", cells: [19, 28, 30, 14, 19, 21, 23, 29] },
  { text: "keeshond", position: "sufword", cells: null },
  { text: "malesherb", position: "sufword", cells: [13, 1, 7, 17, 14, 19, 59, 3] },
  { text: "mansholt", position: "sufword", cells: null },
  { text: "mishandle", position: "sufword", cells: [13, 10, 14, 19, 47, 7, 17] },
  { text: "mishandled", position: "sufword", cells: [13, 10, 14, 19, 47, 7, 43] },
  { text: "mishandling", position: "sufword", cells: [13, 10, 14, 19, 47, 7, 44] },
  { text: "mishap", position: "sufword", cells: [13, 10, 14, 19, 1, 15] },
  { text: "mishear", position: "sufword", cells: [13, 10, 14, 19, 17, 28] },
  { text: "mishit", position: "sufword", cells: null },
  { text: "newshawk", position: "sufword", cells: null },
  { text: "newshen", position: "sufword", cells: [29, 17, 58, 14, 19, 34] },
  { text: "ramshorn", position: "sufword", cells: null },
  { text: "rosmersholm", position: "sufword", cells: [23, 21, 14, 13, 59, 14, 19, 21, 7, 13] },
  { text: "townshend", position: "sufword", cells: [30, 42, 29, 14, 19, 34, 25] },
  { text: "undishearten", position: "sufword", cells: [37, 29, 25, 10, 14, 19, 17, 28, 30, 34] },
  { text: "weisshorn", position: "sufword", cells: null },
  { text: "wilhelmshaven", position: "sufword", cells: [58, 10, 7, 19, 17, 7, 13, 14, 19, 1, 39, 34] },
  { text: "st", position: "always", cells: [12] },
  { text: "asthma", position: "sufword", cells: [1, 14, 57, 13, 1] },
  { text: "bundestag", position: "sufword", cells: [3, 37, 29, 25, 17, 14, 30, 1, 27] },
  { text: "destouche", position: "sufword", cells: [25, 17, 14, 30, 51, 33, 17] },
  { text: "gastight", position: "sufword", cells: [27, 1, 14, 30, 10, 35, 30] },
  { text: "gordonstoun", position: "sufword", cells: [27, 21, 23, 25, 21, 29, 14, 30, 51, 29] },
  { text: "guesstimate", position: "sufword", cells: [27, 37, 17, 14, 14, 30, 10, 13, 1, 30, 17] },
  { text: "guesstimated", position: "sufword", cells: [27, 37, 17, 14, 14, 30, 10, 13, 1, 30, 43] },
  { text: "guesstimating", position: "sufword", cells: [27, 37, 17, 14, 14, 30, 10, 13, 1, 30, 44] },
  { text: "hephaestion", position: "sufword", cells: [19, 17, 15, 19, 1, 17, 12, 10, 21, 29] },
  { text: "isthmi", position: "sufword", cells: [10, 14, 57, 13, 10] },
  { text: "isthmus", position: "sufword", cells: [10, 14, 57, 13, 37, 14] },
  { text: "kreistag", position: "sufword", cells: null },
  { text: "liebestod", position: "sufword", cells: null },
  { text: "mistime", position: "sufword", cells: [13, 10, 14, 16, 30] },
  { text: "painstaking", position: "sufword", cells: [15, 1, 20, 14, 30, 1, 5, 44] },
  { text: "pastime", position: "sufword", cells: [15, 1, 14, 16, 30] },
  { text: "reichstag", position: "sufword", cells: [23, 17, 10, 33, 14, 30, 1, 27] },
  { text: "th", position: "always", cells: [57] },
  { text: "bolthole", position: "sufword", cells: null },
  { text: "crosthwait", position: "sufword", cells: [9, 23, 21, 14, 57, 58, 1, 10, 30] },
  { text: "esthwait", position: "sufword", cells: [17, 14, 57, 58, 1, 10, 30] },
  { text: "flatholm", position: "sufword", cells: null },
  { text: "goatherd", position: "sufword", cells: [27, 21, 1, 30, 19, 59, 25] },
  { text: "gotthard", position: "sufword", cells: [27, 21, 30, 30, 19, 28, 25] },
  { text: "knothole", position: "sufword", cells: [5, 29, 21, 30, 19, 21, 7, 17] },
  { text: "lufthansa", position: "sufword", cells: [7, 37, 11, 30, 19, 1, 29, 14, 1] },
  { text: "nighthawk", position: "sufword", cells: [29, 10, 35, 30, 19, 1, 58, 5] },
  { text: "nuthatch", position: "sufword", cells: [29, 37, 30, 19, 1, 30, 33] },
  { text: "porthole", position: "sufword", cells: [15, 21, 23, 30, 19, 21, 7, 17] },
  { text: "pothat", position: "sufword", cells: null },
  { text: "potherb", position: "sufword", cells: [15, 21, 30, 19, 59, 3] },
  { text: "pothunt", position: "sufword", cells: null },
  { text: "rathole", position: "sufword", cells: null },
  { text: "richthofen", position: "sufword", cells: [23, 10, 33, 30, 19, 55, 34] },
  { text: "shorthorn", position: "sufword", cells: [41, 21, 23, 30, 19, 21, 23, 29] },
  { text: "warthog", position: "sufword", cells: [58, 28, 30, 19, 21, 27] },
  { text: "wh", position: "always", cells: [49] },
  { text: "clawhammer", position: "sufword", cells: [9, 7, 1, 58, 19, 1, 13, 13, 59] },
  { text: "dewhurst", position: "sufword", cells: [25, 17, 58, 19, 37, 23, 12] },
  { text: "newham", position: "sufword", cells: null },
  { text: "newhaven", position: "sufword", cells: [29, 17, 58, 19, 1, 39, 34] },
  { text: "pewholder", position: "sufword", cells: [15, 17, 58, 19, 21, 7, 25, 59] },
  { text: "strawhat", position: "sufword", cells: [12, 23, 1, 58, 19, 1, 30] },
  { text: "enough's", position: "word", cells: [34, 4, 14] },
  { text: "enough’s", position: "word", cells: [34, 4, 14] },
  { text: "-enough", position: "word", cells: [36, 34, 51, 35] },
  { text: "enough-", position: "word", cells: [34, 51, 35, 36] },
  { text: "enough", position: "always", cells: [34, 51, 35] },
  { text: "dumbbell", position: "sufword", cells: [25, 37, 13, 3, 3, 17, 7, 7] },
  { text: "subbasement", position: "sufword", cells: [14, 37, 3, 3, 1, 14, 17, 48, 30] },
  { text: "subbing", position: "sufword", cells: [14, 37, 3, 3, 44] },
  { text: "beata", position: "word", cells: [6, 1, 30, 1] },
  { text: "beatae", position: "word", cells: [6, 1, 30, 1, 17] },
  { text: "beati", position: "word", cells: [6, 1, 30, 10] },
  { text: "beatus", position: "word", cells: [6, 1, 30, 37, 14] },
  { text: "beche", position: "word", cells: [3, 17, 33, 17] },
  { text: "beches", position: "word", cells: [3, 17, 33, 17, 14] },
  { text: "bede", position: "word", cells: [3, 43, 17] },
  { text: "beden", position: "word", cells: [3, 43, 34] },
  { text: "bedes", position: "word", cells: [3, 43, 17, 14] },
  { text: "beghard", position: "sufword", cells: [3, 17, 27, 19, 28, 25] },
  { text: "bein", position: "word", cells: [3, 17, 20] },
  { text: "beins", position: "word", cells: [3, 17, 20, 14] },
  { text: "bekesy", position: "sufword", cells: null },
  { text: "belafon", position: "sufword", cells: null },
  { text: "belamour", position: "sufword", cells: [3, 17, 7, 1, 13, 51, 23] },
  { text: "benadryl", position: "sufword", cells: [3, 34, 1, 25, 23, 61, 7] },
  { text: "benammi", position: "word", cells: [3, 34, 1, 13, 13, 10] },
  { text: "benefic", position: "word", cells: [6, 29, 17, 11, 10, 9] },
  { text: "benomyl", position: "sufword", cells: [3, 34, 21, 13, 61, 7] },
  { text: "beresford", position: "sufword", cells: [3, 59, 17, 14, 63, 25] },
  { text: "berewick", position: "sufword", cells: [3, 59, 17, 58, 10, 9, 5] },
  { text: "best", position: "word", cells: [3, 17, 12] },
  { text: "bested", position: "word", cells: [3, 17, 12, 43] },
  { text: "bester", position: "word", cells: [3, 17, 12, 59] },
  { text: "bestest", position: "word", cells: [3, 17, 12, 17, 12] },
  { text: "besting", position: "word", cells: [3, 17, 12, 44] },
  { text: "bestness", position: "word", cells: [3, 17, 12, 48, 14] },
  { text: "besty", position: "word", cells: [3, 17, 12, 61] },
  { text: "bete", position: "word", cells: null },
  { text: "betes", position: "word", cells: null },
  { text: "bethabar", position: "sufword", cells: [6, 57, 1, 3, 28] },
  { text: "bethank", position: "sufword", cells: [6, 57, 1, 29, 5] },
  { text: "bethesda", position: "sufword", cells: [6, 46, 14, 25, 1] },
  { text: "bethroot", position: "sufword", cells: [3, 17, 57, 23, 21, 21, 30] },
  { text: "bethuel", position: "sufword", cells: [3, 17, 57, 37, 17, 7] },
  { text: "bethune", position: "sufword", cells: [3, 17, 57, 37, 29, 17] },
  { text: "betonies", position: "word", cells: null },
  { text: "betony", position: "word", cells: null },
  { text: "bewick", position: "sufword", cells: null },
  { text: "bewit", position: "word", cells: null },
  { text: "bewits", position: "word", cells: null },
  { text: "beyer", position: "sufword", cells: [3, 17, 61, 59] },
  { text: "beg", position: "word", cells: null },
  { text: "bein'", position: "sufword", cells: [6, 10, 29, 4] },
  { text: "betws", position: "always", cells: [3, 17, 30, 58, 14] },
  { text: "cch", position: "always", cells: [9, 33] },
  { text: "arccosine", position: "sufword", cells: [28, 9, 9, 21, 14, 20, 17] },
  { text: "conakry", position: "sufword", cells: [9, 21, 29, 1, 5, 23, 61] },
  { text: "conan", position: "sufword", cells: [9, 21, 29, 1, 29] },
  { text: "conned", position: "sufword", cells: [9, 21, 29, 29, 43] },
  { text: "dish", position: "word", cells: [25, 10, 41] },
  { text: "disher", position: "word", cells: [25, 10, 41, 59] },
  { text: "dishers", position: "word", cells: [25, 10, 41, 59, 14] },
  { text: "dishon", position: "word", cells: [25, 10, 41, 21, 29] },
  { text: "dishy", position: "word", cells: [25, 10, 41, 61] },
  { text: "disulphide", position: "word", cells: [25, 10, 14, 37, 7, 15, 19, 10, 25, 17] },
  { text: "areaway", position: "sufword", cells: [28, 2, 58, 1, 61] },
  { text: "battleax", position: "always", cells: null },
  { text: "deair", position: "sufword", cells: null },
  { text: "dealbumin", position: "sufword", cells: [25, 17, 1, 7, 3, 37, 13, 20] },
  { text: "dealcohol", position: "sufword", cells: null },
  { text: "deall", position: "begword", cells: null },
  { text: "deanthropo", position: "sufword", cells: [25, 17, 1, 29, 57, 23, 21, 15, 21] },
  { text: "deapp", position: "begword", cells: null },
  { text: "deash", position: "sufword", cells: [25, 17, 1, 41] },
  { text: "deasp", position: "begword", cells: null },
  { text: "deass", position: "begword", cells: null },
  { text: "eance", position: "midendword", cells: [17, 40, 17] },
  { text: "eand", position: "midendword", cells: [17, 47] },
  { text: "ear", position: "always", cells: [17, 28] },
  { text: "eaway", position: "midendword", cells: [17, 1, 58, 1, 61] },
  { text: "flearidden", position: "sufword", cells: [11, 7, 2, 23, 10, 25, 25, 34] },
  { text: "geanticline", position: "sufword", cells: [27, 17, 1, 29, 30, 10, 9, 7, 20, 17] },
  { text: "learig", position: "sufword", cells: [7, 2, 23, 10, 27] },
  { text: "limeade", position: "sufword", cells: null },
  { text: "orangeade", position: "sufword", cells: null },
  { text: "pineapple", position: "always", cells: [15, 20, 17, 1, 15, 15, 7, 17] },
  { text: "poleax", position: "always", cells: null },
  { text: "preachiev", position: "sufword", cells: [15, 23, 17, 1, 33, 10, 17, 39] },
  { text: "preach", position: "sufword", cells: [15, 23, 2, 33] },
  { text: "preakness", position: "sufword", cells: [15, 23, 2, 5, 48, 14] },
  { text: "reachiev", position: "sufword", cells: [23, 17, 1, 33, 10, 17, 39] },
  { text: "readap", position: "begword", cells: null },
  { text: "readd", position: "sufword", cells: null },
  { text: "readj", position: "begword", cells: null },
  { text: "readme", position: "word", cells: [23, 2, 25, 13, 17] },
  { text: "readmes", position: "word", cells: [23, 2, 25, 13, 17, 14] },
  { text: "readm", position: "begword", cells: null },
  { text: "readonly", position: "sufword", cells: [23, 2, 25, 21, 29, 7, 61] },
  { text: "readout", position: "sufword", cells: [23, 2, 25, 51, 30] },
  { text: "readv", position: "begword", cells: null },
  { text: "reagan", position: "sufword", cells: [23, 2, 27, 1, 29] },
  { text: "reagit", position: "sufword", cells: null },
  { text: "reagr", position: "sufword", cells: null },
  { text: "realig", position: "begword", cells: null },
  { text: "realter", position: "sufword", cells: [23, 17, 1, 7, 30, 59] },
  { text: "reamalg", position: "begword", cells: null },
  { text: "reamass", position: "sufword", cells: null },
  { text: "reamend", position: "sufword", cells: [23, 17, 1, 13, 34, 25] },
  { text: "rean", position: "begword", cells: null },
  { text: "reapolog", position: "begword", cells: null },
  { text: "reapp", position: "begword", cells: null },
  { text: "reasty", position: "sufword", cells: [23, 2, 12, 61] },
  { text: "reatt", position: "begword", cells: null },
  { text: "reave", position: "word", cells: [23, 2, 39, 17] },
  { text: "reaved", position: "word", cells: [23, 2, 39, 43] },
  { text: "reaves", position: "word", cells: [23, 2, 39, 17, 14] },
  { text: "reaving", position: "word", cells: [23, 2, 39, 44] },
  { text: "reav", position: "begword", cells: null },
  { text: "reaw", position: "begword", cells: null },
  { text: "seaway", position: "sufword", cells: [14, 2, 58, 1, 61] },
  { text: "tearoom", position: "sufword", cells: [30, 2, 23, 21, 21, 13] },
  { text: "unreass", position: "begword", cells: null },
  { text: "wideawak", position: "always", cells: null },
  { text: "wiseacr", position: "always", cells: null },
  { text: "gilead", position: "sufword", cells: [27, 10, 7, 17, 1, 25] },
  { text: "deandre", position: "sufword", cells: [25, 2, 29, 25, 23, 17] },
  { text: "deanna", position: "sufword", cells: [25, 17, 1, 29, 29, 1] },
  { text: "boreas", position: "sufword", cells: [3, 21, 23, 17, 1, 14] },
  { text: "roseann", position: "sufword", cells: [23, 21, 14, 17, 1, 29, 29] },
  { text: "leah", position: "sufword", cells: [7, 17, 1, 19] },
  { text: "leann", position: "word", cells: [7, 17, 1, 29, 29] },
  { text: "leanna", position: "sufword", cells: [7, 17, 1, 29, 29, 1] },
  { text: "leanne", position: "word", cells: [7, 17, 1, 29, 29, 17] },
  { text: "bluenose", position: "sufword", cells: [3, 7, 37, 17, 29, 21, 14, 17] },
  { text: "bottleneck", position: "sufword", cells: [3, 21, 30, 30, 7, 17, 29, 17, 9, 5] },
  { text: "forenoon", position: "sufword", cells: [63, 17, 29, 21, 21, 29] },
  { text: "toenail", position: "sufword", cells: [30, 21, 17, 29, 1, 10, 7] },
  { text: "turtleneck", position: "sufword", cells: [30, 37, 23, 30, 7, 17, 29, 17, 9, 5] },
  { text: "ffor", position: "always", cells: [11, 63] },
  { text: "chifforobe", position: "sufword", cells: [33, 10, 22, 21, 23, 21, 3, 17] },
  { text: "iness", position: "midendword", cells: [10, 48, 14] },
  { text: "multinational", position: "sufword", cells: [13, 37, 7, 30, 20, 1, 48, 29, 1, 7] },
  { text: "cannot", position: "always", cells: [56, 9] },
  { text: "character", position: "always", cells: [16, 33] },
  { text: "day", position: "always", cells: [16, 25] },
  { text: "dayan", position: "sufword", cells: [25, 1, 61, 1, 29] },
  { text: "whaddaya", position: "sufword", cells: [49, 1, 25, 25, 1, 61, 1] },
  { text: "ever", position: "always", cells: [16, 17] },
  { text: "eever", position: "always", cells: [17, 17, 39, 59] },
  { text: "iever", position: "always", cells: [10, 17, 39, 59] },
  { text: "bellevernon", position: "sufword", cells: [3, 17, 7, 7, 17, 39, 59, 29, 21, 29] },
  { text: "echeveria", position: "sufword", cells: [17, 33, 17, 39, 59, 10, 1] },
  { text: "evernia", position: "sufword", cells: [17, 39, 59, 29, 10, 1] },
  { text: "eversion", position: "always", cells: [17, 39, 59, 40, 29] },
  { text: "evert", position: "sufword", cells: [17, 39, 59, 30] },
  { text: "everton", position: "sufword", cells: [16, 17, 30, 21, 29] },
  { text: "evertebra", position: "always", cells: [17, 39, 59, 30, 17, 3, 23, 1] },
  { text: "evertib", position: "always", cells: [17, 39, 59, 30, 10, 3] },
  { text: "grevera", position: "sufword", cells: [27, 23, 17, 39, 59, 1] },
  { text: "guenevere", position: "sufword", cells: [27, 37, 34, 17, 39, 59, 17] },
  { text: "guinevere", position: "sufword", cells: [27, 37, 20, 17, 39, 59, 17] },
  { text: "monteverdi", position: "sufword", cells: [13, 21, 29, 30, 17, 39, 59, 25, 10] },
  { text: "nevers", position: "word", cells: [29, 17, 39, 59, 14] },
  { text: "preverb", position: "sufword", cells: [15, 23, 17, 39, 59, 3] },
  { text: "preverna", position: "sufword", cells: [15, 23, 17, 39, 59, 29, 1] },
  { text: "quinqueverb", position: "sufword", cells: [31, 37, 20, 31, 37, 17, 39, 59, 3] },
  { text: "semievergreen", position: "sufword", cells: [14, 17, 13, 10, 16, 17, 27, 23, 17, 34] },
  { text: "unevert", position: "sufword", cells: [37, 29, 17, 39, 59, 30] },
  { text: "viceversa", position: "sufword", cells: [39, 10, 9, 17, 39, 59, 14, 1] },
  { text: "reverb", position: "always", cells: [23, 17, 39, 59, 3] },
  { text: "reversab", position: "always", cells: [23, 17, 39, 59, 14, 1, 3] },
  { text: "reversib", position: "always", cells: [23, 17, 39, 59, 14, 10, 3] },
  { text: "reversif", position: "always", cells: [23, 17, 39, 59, 14, 10, 11] },
  { text: "prereversal", position: "sufword", cells: [15, 23, 59, 17, 39, 59, 14, 1, 7] },
  { text: "prereverse", position: "sufword", cells: [15, 23, 59, 17, 39, 59, 14, 17] },
  { text: "prereversed", position: "sufword", cells: [15, 23, 59, 17, 39, 59, 14, 43] },
  { text: "prereversing", position: "sufword", cells: [15, 23, 59, 17, 39, 59, 14, 44] },
  { text: "revering", position: "sufword", cells: [23, 17, 39, 59, 44] },
  { text: "reversal", position: "sufword", cells: [23, 17, 39, 59, 14, 1, 7] },
  { text: "reversing", position: "sufword", cells: [23, 17, 39, 59, 14, 44] },
  { text: "reversive", position: "sufword", cells: [23, 17, 39, 59, 14, 10, 39, 17] },
  { text: "reverence", position: "sufword", cells: [23, 16, 17, 48, 17] },
  { text: "reverencing", position: "sufword", cells: [23, 16, 17, 34, 9, 44] },
  { text: "reverend", position: "sufword", cells: [23, 16, 17, 34, 25] },
  { text: "reverent", position: "sufword", cells: [23, 16, 17, 34, 30] },
  { text: "revertend", position: "sufword", cells: [23, 16, 17, 30, 34, 25] },
  { text: "revert", position: "sufword", cells: [23, 17, 39, 59, 30] },
  { text: "unrevered", position: "sufword", cells: [37, 29, 23, 17, 39, 59, 43] },
  { text: "severish", position: "sufword", cells: [14, 17, 39, 59, 10, 41] },
  { text: "severus", position: "sufword", cells: [14, 17, 39, 59, 37, 14] },
  { text: "severed", position: "always", cells: [14, 16, 17, 43] },
  { text: "father", position: "always", cells: [16, 11] },
  { text: "had", position: "always", cells: [56, 19] },
  { text: "phad", position: "always", cells: [15, 19, 1, 25] },
  { text: "hades", position: "sufword", cells: [19, 1, 25, 17, 14] },
  { text: "hadrian", position: "sufword", cells: [19, 1, 25, 23, 10, 1, 29] },
  { text: "menhaden", position: "sufword", cells: [13, 34, 19, 1, 25, 34] },
  { text: "here", position: "always", cells: [16, 19] },
  { text: "hered", position: "always", cells: [19, 59, 43] },
  { text: "herence", position: "always", cells: [19, 59, 48, 17] },
  { text: "herencies", position: "always", cells: [19, 59, 34, 9, 10, 17, 14] },
  { text: "herency", position: "always", cells: [19, 59, 34, 9, 61] },
  { text: "herend", position: "always", cells: [19, 59, 34, 25] },
  { text: "herent", position: "always", cells: [19, 59, 34, 30] },
  { text: "herer", position: "always", cells: [19, 59, 59] },
  { text: "heredofamil", position: "sufword", cells: [19, 59, 43, 21, 11, 1, 13, 10, 7] },
  { text: "hereford", position: "sufword", cells: [19, 59, 17, 63, 25] },
  { text: "hereld", position: "sufword", cells: [19, 59, 17, 7, 25] },
  { text: "herenach", position: "sufword", cells: [19, 59, 34, 1, 33] },
  { text: "hereward", position: "sufword", cells: [19, 59, 17, 58, 28, 25] },
  { text: "herez", position: "sufword", cells: [19, 59, 17, 53] },
  { text: "pheres", position: "word", cells: [15, 19, 59, 17, 14] },
  { text: "know", position: "always", cells: [16, 5] },
  { text: "lucknow", position: "sufword", cells: [7, 37, 9, 5, 29, 42] },
  { text: "lord", position: "always", cells: [16, 7] },
  { text: "bachelordom", position: "sufword", cells: [3, 1, 33, 17, 7, 21, 23, 25, 21, 13] },
  { text: "chlordan", position: "sufword", cells: [33, 7, 21, 23, 25, 1, 29] },
  { text: "chlordiazep", position: "sufword", cells: [33, 7, 21, 23, 25, 10, 1, 53, 17, 15] },
  { text: "tailordom", position: "sufword", cells: null },
  { text: "many", position: "always", cells: [56, 13] },
  { text: "mother", position: "always", cells: [16, 13] },
  { text: "name", position: "always", cells: [16, 29] },
  { text: "nament", position: "always", cells: [29, 1, 48, 30] },
  { text: "namese", position: "endword", cells: null },
  { text: "namesian", position: "endword", cells: null },
  { text: "anamelech", position: "sufword", cells: [1, 29, 1, 13, 17, 7, 17, 33] },
  { text: "anamelek", position: "sufword", cells: null },
  { text: "anametadrom", position: "sufword", cells: null },
  { text: "coname", position: "sufword", cells: [9, 21, 16, 29] },
  { text: "one", position: "always", cells: [16, 21] },
  { text: "abalone", position: "sufword", cells: [1, 3, 1, 7, 21, 29, 17] },
  { text: "alcyone", position: "sufword", cells: [1, 7, 9, 61, 21, 29, 17] },
  { text: "anemone", position: "sufword", cells: [1, 29, 17, 13, 21, 29, 17] },
  { text: "antigone", position: "sufword", cells: [1, 29, 30, 10, 27, 21, 29, 17] },
  { text: "antonescu", position: "sufword", cells: null },
  { text: "argemone", position: "sufword", cells: [28, 27, 17, 13, 21, 29, 17] },
  { text: "baronet", position: "sufword", cells: [3, 28, 21, 29, 17, 30] },
  { text: "bayonet", position: "sufword", cells: [3, 1, 61, 21, 29, 17, 30] },
  { text: "bonedog", position: "sufword", cells: [3, 16, 21, 25, 21, 27] },
  { text: "bonedry", position: "sufword", cells: [3, 16, 21, 25, 23, 61] },
  { text: "bonesteel", position: "sufword", cells: [3, 16, 21, 12, 17, 17, 7] },
  { text: "canzone", position: "sufword", cells: null },
  { text: "cassone", position: "sufword", cells: null },
  { text: "castiglione", position: "sufword", cells: [9, 1, 12, 10, 27, 7, 10, 21, 29, 17] },
  { text: "chitarrone", position: "sufword", cells: [33, 10, 30, 28, 23, 21, 29, 17] },
  { text: "cicerone", position: "sufword", cells: [9, 10, 9, 59, 21, 29, 17] },
  { text: "cleone", position: "sufword", cells: null },
  { text: "clione", position: "sufword", cells: null },
  { text: "colonel", position: "sufword", cells: [9, 21, 7, 21, 29, 17, 7] },
  { text: "comedones", position: "sufword", cells: [9, 21, 13, 43, 21, 29, 17, 14] },
  { text: "coneigh", position: "sufword", cells: [9, 21, 29, 17, 10, 35] },
  { text: "conversazione", position: "sufword", cells: [18, 39, 59, 14, 1, 53, 10, 21, 29, 17] },
  { text: "coronet", position: "always", cells: null },
  { text: "daimon", position: "sufword", cells: null },
  { text: "deone", position: "sufword", cells: null },
  { text: "dione", position: "sufword", cells: null },
  { text: "doblon", position: "sufword", cells: null },
  { text: "donelson", position: "sufword", cells: null },
  { text: "epulones", position: "word", cells: null },
  { text: "erigone", position: "word", cells: [59, 10, 27, 21, 29, 17] },
  { text: "falcones", position: "word", cells: null },
  { text: "gaberones", position: "word", cells: [27, 1, 3, 59, 21, 29, 17, 14] },
  { text: "gaborone", position: "sufword", cells: null },
  { text: "gekkones", position: "word", cells: null },
  { text: "giorgione", position: "sufword", cells: [27, 10, 21, 23, 27, 10, 21, 29, 17] },
  { text: "halcyone", position: "sufword", cells: null },
  { text: "hermione", position: "sufword", cells: [19, 59, 13, 10, 21, 29, 17] },
  { text: "honegger", position: "sufword", cells: [19, 21, 29, 17, 54, 59] },
  { text: "honest", position: "always", cells: [19, 16, 21, 12] },
  { text: "ionesco", position: "sufword", cells: [10, 21, 29, 17, 14, 9, 21] },
  { text: "jasione", position: "sufword", cells: null },
  { text: "joneses", position: "sufword", cells: [26, 16, 21, 14, 17, 14] },
  { text: "jonesian", position: "sufword", cells: [26, 16, 21, 14, 10, 1, 29] },
  { text: "jonestown", position: "sufword", cells: [26, 16, 21, 14, 30, 42, 29] },
  { text: "krone", position: "sufword", cells: [5, 23, 21, 29, 17] },
  { text: "kronen", position: "sufword", cells: [5, 23, 21, 29, 34] },
  { text: "kroner", position: "sufword", cells: [5, 23, 21, 29, 59] },
  { text: "laestrygones", position: "sufword", cells: [7, 1, 17, 12, 23, 61, 27, 21, 29, 17, 14] },
  { text: "lazzarone", position: "sufword", cells: [7, 1, 53, 53, 28, 21, 29, 17] },
  { text: "lugones", position: "sufword", cells: null },
  { text: "madrone", position: "sufword", cells: null },
  { text: "mantellone", position: "sufword", cells: null },
  { text: "mbabone", position: "sufword", cells: null },
  { text: "merioneth", position: "sufword", cells: [13, 59, 10, 21, 29, 17, 57] },
  { text: "minestrone", position: "sufword", cells: [13, 20, 17, 12, 23, 21, 29, 17] },
  { text: "moliones", position: "sufword", cells: null },
  { text: "monegasqu", position: "sufword", cells: null },
  { text: "monembry", position: "sufword", cells: null },
  { text: "monepi", position: "sufword", cells: null },
  { text: "monet", position: "sufword", cells: [13, 21, 29, 17, 30] },
  { text: "moneth", position: "word", cells: [13, 21, 29, 17, 57] },
  { text: "monetary", position: "always", cells: [13, 16, 21, 30, 28, 61] },
  { text: "montefiascone", position: "sufword", cells: null },
  { text: "morone", position: "sufword", cells: null },
  { text: "myrmidones", position: "sufword", cells: null },
  { text: "none", position: "word", cells: [29, 16, 21] },
  { text: "nones", position: "word", cells: [29, 16, 21, 14] },
  { text: "nonesuches", position: "sufword", cells: [29, 16, 21, 14, 37, 33, 17, 14] },
  { text: "nonetheless", position: "sufword", cells: [29, 16, 21, 46, 40, 14] },
  { text: "oenone", position: "sufword", cells: [21, 34, 21, 29, 17] },
  { text: "oneal", position: "sufword", cells: [21, 29, 2, 7] },
  { text: "oneco", position: "sufword", cells: null },
  { text: "oneida", position: "sufword", cells: [21, 29, 17, 10, 25, 1] },
  { text: "oneil", position: "sufword", cells: null },
  { text: "onekam", position: "sufword", cells: null },
  { text: "oneont", position: "sufword", cells: null },
  { text: "onesimus", position: "sufword", cells: null },
  { text: "onesiphorus", position: "sufword", cells: null },
  { text: "opilione", position: "sufword", cells: null },
  { text: "padrone", position: "sufword", cells: null },
  { text: "panettone", position: "sufword", cells: null },
  { text: "papiliones", position: "sufword", cells: null },
  { text: "pensione", position: "word", cells: [15, 34, 14, 10, 21, 29, 17] },
  { text: "pensiones", position: "word", cells: [15, 34, 14, 10, 21, 29, 17, 14] },
  { text: "peones", position: "word", cells: null },
  { text: "persephone", position: "sufword", cells: [15, 59, 14, 17, 15, 19, 21, 29, 17] },
  { text: "pronegotia", position: "sufword", cells: null },
  { text: "sawboneses", position: "sufword", cells: [14, 1, 58, 3, 16, 21, 14, 17, 14] },
  { text: "schiavone", position: "sufword", cells: [14, 33, 10, 1, 39, 21, 29, 17] },
  { text: "scorpiones", position: "word", cells: null },
  { text: "sirione", position: "sufword", cells: null },
  { text: "soffione", position: "sufword", cells: [14, 55, 11, 10, 21, 29, 17] },
  { text: "spumone", position: "sufword", cells: [14, 15, 37, 13, 21, 29, 17] },
  { text: "stonestreet", position: "sufword", cells: [12, 16, 21, 12, 23, 17, 17, 30] },
  { text: "struthiones", position: "word", cells: [12, 23, 37, 57, 10, 21, 29, 17, 14] },
  { text: "sturiones", position: "word", cells: [12, 37, 23, 10, 21, 29, 17, 14] },
  { text: "suiones", position: "word", cells: null },
  { text: "sycones", position: "word", cells: null },
  { text: "tarsonemid", position: "sufword", cells: [30, 28, 14, 21, 29, 17, 13, 10, 25] },
  { text: "tonelada", position: "sufword", cells: null },
  { text: "torrone", position: "sufword", cells: null },
  { text: "zabaglione", position: "sufword", cells: null },
  { text: "ought", position: "always", cells: [16, 51] },
  { text: "part", position: "always", cells: [16, 15] },
  { text: "parthe", position: "always", cells: [15, 28, 46] },
  { text: "parth", position: "always", cells: [15, 28, 57] },
  { text: "apartheid", position: "always", cells: [1, 16, 15, 19, 17, 10, 25] },
  { text: "question", position: "always", cells: [16, 31] },
  { text: "right", position: "always", cells: [16, 23] },
  { text: "some", position: "always", cells: [16, 14] },
  { text: "somever", position: "always", cells: [14, 21, 13, 16, 17] },
  { text: "besomer", position: "sufword", cells: [6, 14, 21, 13, 59] },
  { text: "blossomed", position: "sufword", cells: [3, 7, 21, 14, 14, 21, 13, 43] },
  { text: "spirit", position: "always", cells: [56, 14] },
  { text: "their", position: "always", cells: [56, 46] },
  { text: "these", position: "always", cells: [24, 46] },
  { text: "antitheses", position: "sufword", cells: [1, 29, 30, 10, 46, 14, 17, 14] },
  { text: "hypotheses", position: "sufword", cells: [19, 61, 15, 21, 46, 14, 17, 14] },
  { text: "parentheses", position: "sufword", cells: [15, 28, 34, 46, 14, 17, 14] },
  { text: "syntheses", position: "sufword", cells: [14, 61, 29, 46, 14, 17, 14] },
  { text: "theses", position: "sufword", cells: [46, 14, 17, 14] },
  { text: "theseus", position: "sufword", cells: [46, 14, 17, 37, 14] },
  { text: "through", position: "always", cells: [16, 57] },
  { text: "time", position: "always", cells: [16, 30] },
  { text: "timent", position: "always", cells: [30, 10, 48, 30] },
  { text: "timeter", position: "always", cells: [30, 10, 13, 17, 30, 59] },
  { text: "timetric", position: "always", cells: null },
  { text: "timetry", position: "always", cells: null },
  { text: "centime", position: "sufword", cells: [9, 34, 30, 10, 13, 17] },
  { text: "latimer", position: "sufword", cells: [7, 1, 30, 10, 13, 59] },
  { text: "lattimer", position: "sufword", cells: [7, 1, 30, 30, 10, 13, 59] },
  { text: "mortimer", position: "sufword", cells: [13, 21, 23, 30, 10, 13, 59] },
  { text: "optime", position: "sufword", cells: null },
  { text: "underogatory", position: "sufword", cells: [37, 29, 25, 59, 21, 27, 1, 30, 21, 23, 61] },
  { text: "under", position: "always", cells: [16, 37] },
  { text: "upon", position: "always", cells: [24, 37] },
  { text: "dupont", position: "sufword", cells: [25, 37, 15, 21, 29, 30] },
  { text: "where", position: "always", cells: [16, 49] },
  { text: "where'er", position: "sufword", cells: [49, 59, 17, 4, 59] },
  { text: "where’er", position: "sufword", cells: [49, 59, 17, 4, 59] },
  { text: "whereupon", position: "sufword", cells: [16, 49, 24, 37] },
  { text: "wherever", position: "sufword", cells: [49, 59, 16, 17] },
  { text: "whose", position: "always", cells: [24, 49] },
  { text: "word", position: "always", cells: [24, 58] },
  { text: "work", position: "always", cells: [16, 58] },
  { text: "dworkin", position: "sufword", cells: [25, 58, 21, 23, 5, 20] },
  { text: "world", position: "always", cells: [56, 58] },
  { text: "young", position: "always", cells: [16, 61] },
  { text: "fiance", position: "sufword", cells: [11, 10, 1, 29, 9, 17] },
  { text: "encephal", position: "always", cells: [34, 9, 17, 15, 19, 1, 7] },
  { text: "overfull", position: "sufword", cells: [21, 39, 59, 11, 37, 7, 7] },
  { text: "biscuity", position: "word", cells: [3, 10, 14, 9, 37, 10, 30, 61] },
  { text: "dacoity", position: "word", cells: [25, 1, 9, 21, 10, 30, 61] },
  { text: "fruity", position: "word", cells: [11, 23, 37, 10, 30, 61] },
  { text: "hoity-toity", position: "word", cells: [19, 21, 10, 30, 61, 36, 30, 21, 10, 30, 61] },
  { text: "rabbity", position: "word", cells: [23, 1, 6, 10, 30, 61] },
  { text: "pityard", position: "word", cells: [15, 10, 30, 61, 28, 25] },
  { text: "antitype", position: "sufword", cells: [1, 29, 30, 10, 30, 61, 15, 17] },
  { text: "captainess", position: "sufword", cells: [9, 1, 15, 30, 1, 10, 20, 17, 14, 14] },
  { text: "chieftainess", position: "sufword", cells: [33, 10, 17, 11, 30, 1, 20, 17, 14, 14] },
  { text: "citizeness", position: "sufword", cells: [9, 10, 30, 10, 53, 34, 17, 14, 14] },
  { text: "heatheness", position: "sufword", cells: [19, 2, 46, 29, 17, 14, 14] },
  { text: "nong", position: "begword", cells: null },
  { text: "songhai", position: "sufword", cells: [14, 21, 29, 35, 1, 10] },
  { text: "cation", position: "sufword", cells: [9, 1, 30, 10, 21, 29] },
  { text: "mention", position: "always", cells: [13, 34, 48, 29] },
  { text: "herf", position: "word", cells: null },
  { text: "mst", position: "word", cells: null },
  { text: "agst", position: "word", cells: null },
  { text: "agsts", position: "word", cells: null },
  { text: "alth", position: "word", cells: null },
  { text: "alths", position: "word", cells: null },
  { text: "bec", position: "word", cells: null },
  { text: "bef", position: "word", cells: null },
  { text: "beh", position: "word", cells: null },
  { text: "bel", position: "word", cells: null },
  { text: "ben", position: "word", cells: [3, 34] },
  { text: "bes", position: "word", cells: null },
  { text: "bet", position: "word", cells: null },
  { text: "bey", position: "word", cells: null },
  { text: "chn", position: "word", cells: null },
  { text: "concv", position: "word", cells: null },
  { text: "concvg", position: "word", cells: null },
  { text: "fst", position: "word", cells: null },
  { text: "fsts", position: "word", cells: null },
  { text: "herf", position: "word", cells: null },
  { text: "mch", position: "word", cells: null },
  { text: "mst", position: "word", cells: null },
  { text: "onef", position: "word", cells: null },
  { text: "ourvs", position: "word", cells: null },
  { text: "percv", position: "word", cells: null },
  { text: "percvd", position: "word", cells: null },
  { text: "percvg", position: "word", cells: null },
  { text: "percvr", position: "word", cells: null },
  { text: "percvs", position: "word", cells: null },
  { text: "perh", position: "word", cells: null },
  { text: "perhs", position: "word", cells: null },
  { text: "shd", position: "word", cells: null },
  { text: "sch", position: "word", cells: null },
  { text: "themvs", position: "word", cells: null },
  { text: "thyf", position: "word", cells: null },
  { text: "abouts", position: "word", cells: [1, 3, 51, 30, 14] },
  { text: "almosts", position: "word", cells: [1, 7, 13, 21, 12, 14] },
  { text: "hims", position: "word", cells: [19, 10, 13, 14] },
  { text: "herfs", position: "word", cells: null },
  { text: "mchs", position: "word", cells: null },
  { text: "msta", position: "word", cells: null },
  { text: "msts", position: "word", cells: null },
  { text: "msty", position: "word", cells: null },
  { text: "onefs", position: "word", cells: null },
  { text: "ourvss", position: "word", cells: null },
  { text: "percvd", position: "word", cells: null },
  { text: "percvg", position: "word", cells: null },
  { text: "percvr", position: "word", cells: null },
  { text: "percvrs", position: "word", cells: null },
  { text: "percvs", position: "word", cells: null },
  { text: "schs", position: "word", cells: null },
  { text: "shds", position: "word", cells: null },
  { text: "tgrness", position: "word", cells: null },
  { text: "themvss", position: "word", cells: null },
  { text: "thyfs", position: "word", cells: null },
  { text: "unpercv", position: "word", cells: null },
  { text: "unpercvd", position: "word", cells: null },
  { text: "unpercvg", position: "word", cells: null },
  { text: "unpercvrr", position: "word", cells: null },
  { text: "unpercvs", position: "word", cells: null },
  { text: "preadmit", position: "sufword", cells: [15, 23, 17, 1, 25, 13, 10, 30] },
  { text: "rared", position: "word", cells: [23, 1, 23, 43] },
  { text: "somesch", position: "word", cells: [14, 21, 13, 17, 14, 9, 19] },
  { text: "ing", position: "midendword", cells: [44] },
  { text: "in", position: "always", cells: [20] },
  { text: "bb", position: "midword", cells: [6] },
  { text: "dd", position: "midword", cells: [50] },
  { text: "ea", position: "midword", cells: [2] },
  { text: "en", position: "always", cells: [34] },
  { text: "there", position: "always", cells: [16, 46] },
  { text: "those", position: "always", cells: [24, 57] },
  { text: "ance", position: "midendword", cells: [40, 17] },
  { text: "ence", position: "midendword", cells: [48, 17] },
  { text: "ful", position: "midendword", cells: [48, 7] },
  { text: "ity", position: "midendword", cells: [48, 61] },
  { text: "less", position: "midendword", cells: [40, 14] },
  { text: "ment", position: "midendword", cells: [48, 30] },
  { text: "ness", position: "midendword", cells: [48, 14] },
  { text: "ong", position: "midendword", cells: [48, 27] },
  { text: "ound", position: "midendword", cells: [40, 25] },
  { text: "ount", position: "midendword", cells: [40, 30] },
  { text: "sion", position: "midendword", cells: [40, 29] },
  { text: "tion", position: "midendword", cells: [48, 29] },
];

// ---- Translation engine ----

function isUpper(ch) { return ch >= 'A' && ch <= 'Z'; }
function isLower(ch) { return ch >= 'a' && ch <= 'z'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isLetter(ch) { return isUpper(ch) || isLower(ch); }

// Splits text into maximal runs of letters ('word'), digits ('number'),
// or single other characters ('other' -- space/punctuation/anything
// unrecognized) -- contractions and numeric mode both only ever operate
// within one run, never across a run boundary.
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isLetter(ch)) {
      let j = i + 1;
      while (j < text.length && isLetter(text[j])) j++;
      tokens.push({ type: 'word', text: text.slice(i, j) });
      i = j;
    } else if (isDigit(ch)) {
      let j = i + 1;
      while (j < text.length && isDigit(text[j])) j++;
      tokens.push({ type: 'number', text: text.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: 'other', text: ch });
      i++;
    }
  }
  return tokens;
}

function translateNumberToken(digitsStr) {
  const cells = [UEB_NUMSIGN];
  for (const ch of digitsStr) cells.push(UEB_DIGITS[ch]);
  return cells;
}

function translateOtherToken(ch) {
  const cells = UEB_PUNCTUATION[ch];
  return cells ? cells.slice() : [0]; // unmapped character -> blank cell, graceful fallback
}

// Plain per-letter spelling, lowercase dot patterns only -- capitalization
// is handled once per word by the caller (see capSignsForWord), not here.
// Shared by Grade 1 and by Grade 2's fallback for any letter a contraction
// didn't cover (always called there on an already-lowercased substring).
function translateLettersPlain(letters) {
  const cells = [];
  for (const ch of letters) cells.push(UEB_LETTERS[ch.toLowerCase()]);
  return cells;
}

// § Capitalization — UEB's capsword indicator: a doubled capital sign
// (dots 6,6) once at the front of a word means the *whole word* is
// capitalized, replacing what would otherwise be a separate capital
// sign before every single letter. Applies in both grades -- it's a
// general capitalization convention, not tied to contractions. Examines
// the word's original, case-preserved text.
//
// Only a *multi*-letter run gets the doubled sign; a standalone single
// capital letter (e.g. a lettered grid street like "B Street") always
// uses just one capital sign -- see translateGrade2's own handling of
// that case, which also needs the letter sign below.
function capSignsForWord(word) {
  if (word.length > 1 && [...word].every(isUpper)) return [UEB_CAPSIGN, UEB_CAPSIGN];
  if (isUpper(word[0])) return [UEB_CAPSIGN];
  return [];
}

// § Grade 2 — dots 5,6, the UEB letter sign. A standalone single letter
// with no contraction of its own always falls through to its plain
// letter cell -- but for the letters that also serve as one of the 23
// alphabetic wordsigns (see UEB_WORDSIGN_RULES), that plain cell is the
// *same* dot pattern as the wordsign's whole-word contraction (that's
// the whole mnemonic behind wordsigns: letter b's own shape doubles as
// "but", etc.). Note this fallback never actually goes through the
// wordsign *rule* -- that only matches a wordsign's full spelling (the
// literal word "but", three letters); a standalone single letter is
// always shorter than every wordsign's own text, so it can never match
// one. The plain-letter fallback just happens to produce the identical
// cell, since that's how wordsigns are defined in the first place.
// Needed regardless of capitalization -- this app's real content never
// has a standalone single letter meaning the actual grammatical word
// (that always appears fully spelled out, and gets contracted
// correctly by the normal wordsign rule); every standalone single
// letter it produces is a literal letter (e.g. a lettered grid street,
// "B Street"), so the letter sign is always correct there, capitalized
// or not -- capitalized letters additionally get the capital sign right
// after it. Derived from the wordsign table itself (which letters'
// shapes are actually reused) rather than a separate hand-maintained
// list, so the two can't drift apart. A few letters have no wordsign
// assigned to their shape at all -- a, i, o, each already a genuine
// one-letter English word on its own ("a", "I", "o") -- so a standalone
// A/I/O, either case, is never ambiguous with anything and never needs
// the letter sign.
const UEB_LETTERSIGN = 48; // dots 5,6
const WORDSIGN_CELL_VALUES = new Set(UEB_WORDSIGN_RULES.map((rule) => rule.cells[0]));

export function translateGrade1(text) {
  const cells = [];
  for (const token of tokenize(text)) {
    if (token.type === 'word') {
      cells.push(...capSignsForWord(token.text), ...translateLettersPlain(token.text));
    }
    else if (token.type === 'number') cells.push(...translateNumberToken(token.text));
    else cells.push(...translateOtherToken(token.text));
  }
  return cells;
}

// § Grade 2 — whether a rule at word-position "start" (length "len",
// word length "n") is actually eligible there, per its liblouis opcode.
// sufword's documented meaning ("a word, or the beginning of a word") is
// a strict superset of begword given our one-word-at-a-time model, so
// the two share a case.
function positionOk(position, start, len, n) {
  const atStart = start === 0;
  const atEnd = start + len === n;
  switch (position) {
    case 'always': return true;
    case 'word': case 'alphabetic-wordsign': return atStart && atEnd;
    case 'begword': case 'sufword': return atStart;
    case 'endword': return atEnd;
    case 'midword': return !atStart && !atEnd;
    case 'midendword': return !atStart;
    default: return false;
  }
}

const RULES_BY_TEXT = new Map();
for (const rule of [...UEB_G2_RULES, ...UEB_WORDSIGN_RULES, ...UEB_DOT5_SIGN_RULES]) {
  if (!RULES_BY_TEXT.has(rule.text)) RULES_BY_TEXT.set(rule.text, []);
  RULES_BY_TEXT.get(rule.text).push(rule);
}
const MAX_RULE_LEN = Math.max(...[...RULES_BY_TEXT.keys()].map((t) => t.length));

// § Grade 2 — longest-match-first: at each position, try the longest
// candidate substring with a satisfied position rule before falling back
// to shorter ones, and finally to a single plain (Grade 1) letter if
// nothing at all matches there. Operates on the lowercased word;
// capitalization (capSignsForWord) and the standalone-letter-sign case
// are both applied by the caller (see translateGrade2), not here -- this
// app's message text is always plain title-case-or-lowercase-or-ALL-CAPS
// words, never irregular mixed case within a word, so examining just the
// word's overall capitalization pattern (rather than tracking every
// individual letter's case through contraction matching) is the correct,
// sufficient case to handle (see tmap spec.md § Braille translator).
function translateWordGrade2(word) {
  const lower = word.toLowerCase();
  const n = lower.length;
  const cells = [];
  let i = 0;
  while (i < n) {
    let matchedLen = 0;
    let matchedRule = null;
    const maxLen = Math.min(MAX_RULE_LEN, n - i);
    for (let len = maxLen; len >= 1; len--) {
      const candidates = RULES_BY_TEXT.get(lower.slice(i, i + len));
      if (!candidates) continue;
      const rule = candidates.find((r) => positionOk(r.position, i, len, n));
      if (rule) { matchedLen = len; matchedRule = rule; break; }
    }
    if (matchedRule) {
      cells.push(...(matchedRule.cells || translateLettersPlain(lower.slice(i, i + matchedLen))));
      i += matchedLen;
    } else {
      cells.push(UEB_LETTERS[lower[i]]);
      i += 1;
    }
  }
  return cells;
}

export function translateGrade2(text) {
  const cells = [];
  for (const token of tokenize(text)) {
    if (token.type === 'word') {
      const word = token.text;
      const letterCell = word.length === 1 ? UEB_LETTERS[word.toLowerCase()] : null;
      if (letterCell !== null && WORDSIGN_CELL_VALUES.has(letterCell)) {
        // standalone letter whose shape is also a wordsign -- always
        // needs the letter sign, capitalized or not (see UEB_LETTERSIGN
        // above: this never actually goes through the wordsign *rule*,
        // which only matches a wordsign's full spelling, e.g. "but"
        // spelled out -- it's the plain-letter fallback, which happens
        // to produce the identical cell only because a wordsign reuses
        // its letter's own shape). The capital sign is still added only
        // when the letter was actually capitalized.
        const prefix = isUpper(word[0]) ? [UEB_LETTERSIGN, UEB_CAPSIGN] : [UEB_LETTERSIGN];
        cells.push(...prefix, letterCell);
      } else {
        cells.push(...capSignsForWord(word), ...translateWordGrade2(word));
      }
    } else if (token.type === 'number') {
      cells.push(...translateNumberToken(token.text));
    } else {
      cells.push(...translateOtherToken(token.text));
    }
  }
  return cells;
}
