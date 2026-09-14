package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

type workbookData struct {
	sheets  map[string][][]string
	strings []string
}

type candidate struct {
	year, county, name, party, vision, source string
}

type promise struct {
	year, county, name, party, category, title, detail, source string
}

type relationship struct {
	ID, Target string
}

func main() {
	input := flag.String("input", "縣市首長當選人政見整理.xlsx", "source .xlsx workbook")
	output := flag.String("output", "migrations/0002_seed.sql", "generated D1 migration")
	flag.Parse()

	wb, err := openWorkbook(*input)
	if err != nil {
		fatal(err)
	}
	candidates, promises, err := extract(wb)
	if err != nil {
		fatal(err)
	}
	if len(candidates) != 18 || len(promises) != 134 {
		fatal(fmt.Errorf("unexpected source size: got %d candidates and %d promises; want 18 and 134", len(candidates), len(promises)))
	}

	sql, err := buildSQL(candidates, promises)
	if err != nil {
		fatal(err)
	}
	if err := os.WriteFile(*output, []byte(sql), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("generated %s with %d candidates and %d promises\n", *output, len(candidates), len(promises))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "seedgen:", err)
	os.Exit(1)
}

func openWorkbook(filename string) (*workbookData, error) {
	zr, err := zip.OpenReader(filename)
	if err != nil {
		return nil, err
	}
	defer zr.Close()

	files := make(map[string]*zip.File, len(zr.File))
	for _, file := range zr.File {
		files[file.Name] = file
	}
	shared, err := readSharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, fmt.Errorf("shared strings: %w", err)
	}
	sheetRefs, err := readWorkbookSheets(files["xl/workbook.xml"])
	if err != nil {
		return nil, fmt.Errorf("workbook: %w", err)
	}
	rels, err := readRelationships(files["xl/_rels/workbook.xml.rels"])
	if err != nil {
		return nil, fmt.Errorf("relationships: %w", err)
	}

	wb := &workbookData{sheets: map[string][][]string{}, strings: shared}
	for name, relID := range sheetRefs {
		target, ok := rels[relID]
		if !ok {
			return nil, fmt.Errorf("missing relationship %s for sheet %q", relID, name)
		}
		target = strings.TrimPrefix(target, "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Clean(path.Join("xl", target))
		}
		rows, err := readSheet(files[target], shared)
		if err != nil {
			return nil, fmt.Errorf("sheet %q: %w", name, err)
		}
		wb.sheets[name] = rows
	}
	return wb, nil
}

func readSharedStrings(file *zip.File) ([]string, error) {
	if file == nil {
		return nil, nil
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(reader)
	var result []string
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "si" {
			continue
		}
		var node struct {
			Text string `xml:"t"`
			Runs []struct {
				Text string `xml:"t"`
			} `xml:"r"`
		}
		if err := decoder.DecodeElement(&node, &start); err != nil {
			return nil, err
		}
		var builder strings.Builder
		builder.WriteString(node.Text)
		for _, run := range node.Runs {
			builder.WriteString(run.Text)
		}
		result = append(result, builder.String())
	}
	return result, nil
}

func readWorkbookSheets(file *zip.File) (map[string]string, error) {
	if file == nil {
		return nil, errors.New("xl/workbook.xml not found")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(reader)
	result := map[string]string{}
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		var name, relID string
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "name":
				name = attr.Value
			case "id":
				relID = attr.Value
			}
		}
		if name != "" && relID != "" {
			result[name] = relID
		}
	}
}

func readRelationships(file *zip.File) (map[string]string, error) {
	if file == nil {
		return nil, errors.New("workbook relationships not found")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var root struct {
		Items []relationship `xml:"Relationship"`
	}
	if err := xml.NewDecoder(reader).Decode(&root); err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, item := range root.Items {
		result[item.ID] = item.Target
	}
	return result, nil
}

func (r *relationship) UnmarshalXML(decoder *xml.Decoder, start xml.StartElement) error {
	for _, attr := range start.Attr {
		switch attr.Name.Local {
		case "Id":
			r.ID = attr.Value
		case "Target":
			r.Target = attr.Value
		}
	}
	return decoder.Skip()
}

func readSheet(file *zip.File, shared []string) ([][]string, error) {
	if file == nil {
		return nil, errors.New("worksheet file not found")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(reader)
	var rows [][]string
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rows, nil
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "row" {
			continue
		}
		var raw struct {
			Cells []struct {
				Ref    string `xml:"r,attr"`
				Type   string `xml:"t,attr"`
				Value  string `xml:"v"`
				Inline struct {
					Text string `xml:"t"`
				} `xml:"is"`
			} `xml:"c"`
		}
		if err := decoder.DecodeElement(&raw, &start); err != nil {
			return nil, err
		}
		row := []string{}
		for _, cell := range raw.Cells {
			index := columnIndex(cell.Ref)
			for len(row) <= index {
				row = append(row, "")
			}
			value := cell.Value
			switch cell.Type {
			case "s":
				sharedIndex, err := strconv.Atoi(cell.Value)
				if err != nil || sharedIndex < 0 || sharedIndex >= len(shared) {
					return nil, fmt.Errorf("invalid shared string index %q", cell.Value)
				}
				value = shared[sharedIndex]
			case "inlineStr":
				value = cell.Inline.Text
			}
			row[index] = strings.TrimSpace(value)
		}
		rows = append(rows, row)
	}
}

func columnIndex(ref string) int {
	index := 0
	for _, char := range ref {
		if char < 'A' || char > 'Z' {
			break
		}
		index = index*26 + int(char-'A'+1)
	}
	return index - 1
}

func extract(wb *workbookData) ([]candidate, []promise, error) {
	overview, ok := wb.sheets["當選人總覽"]
	if !ok {
		return nil, nil, errors.New("sheet 當選人總覽 not found")
	}
	details, ok := wb.sheets["政見明細"]
	if !ok {
		return nil, nil, errors.New("sheet 政見明細 not found")
	}

	var candidates []candidate
	for _, row := range overview {
		if len(row) < 9 || row[0] == "" || row[0] == "年份" {
			continue
		}
		if _, err := strconv.Atoi(row[0]); err != nil {
			continue
		}
		candidates = append(candidates, candidate{
			year: row[0], county: row[1], name: row[3], party: row[4], vision: row[7], source: row[8],
		})
	}

	var promises []promise
	for _, row := range details {
		if len(row) < 8 || row[0] == "" || row[0] == "年份" {
			continue
		}
		if _, err := strconv.Atoi(row[0]); err != nil {
			continue
		}
		promises = append(promises, promise{
			year: row[0], county: row[1], name: row[2], party: row[3], category: row[4], title: row[5], detail: row[6], source: row[7],
		})
	}
	return candidates, promises, nil
}

func buildSQL(candidates []candidate, promises []promise) (string, error) {
	countyIDs := map[string]string{
		"臺北市": "taipei", "新北市": "new-taipei", "桃園市": "taoyuan",
		"臺中市": "taichung", "臺南市": "tainan", "高雄市": "kaohsiung",
	}
	var out bytes.Buffer
	out.WriteString("-- Generated by cmd/seedgen from 縣市首長當選人政見整理.xlsx.\n")
	out.WriteString("-- Do not edit by hand; run `npm run seed`.\n\n")
	out.WriteString("INSERT INTO elections (year, label) VALUES\n  (2014, '2014 年'),\n  (2018, '2018 年'),\n  (2022, '2022 年');\n\n")
	out.WriteString("INSERT INTO counties (id, name, sort_order) VALUES\n")
	countyOrder := []string{"臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市"}
	for index, name := range countyOrder {
		comma := ","
		if index == len(countyOrder)-1 {
			comma = ";"
		}
		fmt.Fprintf(&out, "  (%s, %s, %d)%s\n", quote(countyIDs[name]), quote(name), index+1, comma)
	}
	out.WriteString("\nINSERT INTO candidates (id, election_year, county_id, name, party, vision, source_reference) VALUES\n")
	candidateIDs := map[string]int{}
	for index, item := range candidates {
		countyID, ok := countyIDs[item.county]
		if !ok {
			return "", fmt.Errorf("unknown county %q", item.county)
		}
		id := index + 1
		candidateIDs[candidateKey(item.year, item.county, item.name)] = id
		comma := ","
		if index == len(candidates)-1 {
			comma = ";"
		}
		fmt.Fprintf(&out, "  (%d, %s, %s, %s, %s, %s, %s)%s\n", id, item.year, quote(countyID), quote(item.name), quote(item.party), quote(item.vision), quote(item.source), comma)
	}

	type categoryRecord struct {
		id, candidateID, order int
		name                   string
	}
	var categories []categoryRecord
	categoryIDs := map[string]int{}
	categoryCounts := map[int]int{}
	for _, item := range promises {
		candidateID, ok := candidateIDs[candidateKey(item.year, item.county, item.name)]
		if !ok {
			return "", fmt.Errorf("promise has no matching candidate: %s %s %s", item.year, item.county, item.name)
		}
		key := fmt.Sprintf("%d\x00%s", candidateID, item.category)
		if _, ok := categoryIDs[key]; !ok {
			id := len(categories) + 1
			categoryCounts[candidateID]++
			categoryIDs[key] = id
			categories = append(categories, categoryRecord{id: id, candidateID: candidateID, name: item.category, order: categoryCounts[candidateID]})
		}
	}
	out.WriteString("\nINSERT INTO categories (id, candidate_id, name, sort_order) VALUES\n")
	for index, item := range categories {
		comma := ","
		if index == len(categories)-1 {
			comma = ";"
		}
		fmt.Fprintf(&out, "  (%d, %d, %s, %d)%s\n", item.id, item.candidateID, quote(item.name), item.order, comma)
	}

	out.WriteString("\nINSERT INTO promises (id, category_id, title, detail, source_reference, sort_order) VALUES\n")
	promiseCounts := map[int]int{}
	for index, item := range promises {
		candidateID := candidateIDs[candidateKey(item.year, item.county, item.name)]
		categoryID := categoryIDs[fmt.Sprintf("%d\x00%s", candidateID, item.category)]
		promiseCounts[categoryID]++
		comma := ","
		if index == len(promises)-1 {
			comma = ";"
		}
		fmt.Fprintf(&out, "  (%d, %d, %s, %s, %s, %d)%s\n", index+1, categoryID, quote(item.title), quote(item.detail), quote(item.source), promiseCounts[categoryID], comma)
	}
	return out.String(), nil
}

func candidateKey(year, county, name string) string {
	return strings.Join([]string{year, county, name}, "\x00")
}

func quote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
