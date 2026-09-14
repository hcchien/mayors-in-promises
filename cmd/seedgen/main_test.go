package main

import "testing"

func TestColumnIndex(t *testing.T) {
	tests := map[string]int{"A1": 0, "H138": 7, "AA2": 26}
	for input, want := range tests {
		if got := columnIndex(input); got != want {
			t.Fatalf("columnIndex(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestQuote(t *testing.T) {
	if got, want := quote("市長's promise"), "'市長''s promise'"; got != want {
		t.Fatalf("quote() = %q, want %q", got, want)
	}
}
