// Sven Co-op Map Directory
// main.go - 
// Crawls the SCMapDB wiki and builds the page with original page content and map downloads
// generates index.html using layout.html
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/net/html"
)

const (
	title           = "Sven Co-op Map Directory"
	baseURL         = "https://scmapdb.wikidot.com"
	pageTitleSuffix = " - Sven Co-op Map Database"
	indexURL        = "/tag:all"
	layout          = "layout.html"
	output          = "index.html"
)

var (
	slugRe       = regexp.MustCompile(`/map:[a-zA-Z0-9-]+(?::[a-zA-Z0-9-]+)?`)
	pageNumRe    = regexp.MustCompile(`/tag:all/p/(\d+)`)
	imageRe      = regexp.MustCompile(`(?i)\.(jpg|jpeg|png|gif)($|\?|#)`)
	archiveRe    = regexp.MustCompile(`(?i)\.(zip|7z|rar|bsp)(\?|#|$)`)
	linksChecked atomic.Int64
	linksDead    atomic.Int64
	// dlClient is tuned for quick link validation
	dlClient = &http.Client{Timeout: 10 * time.Second}
	// pageClient fetches wiki pages for scraping
	pageClient = &http.Client{Timeout: 30 * time.Second}
)

// DownloadLink is one download/mirror link with a human-readable label.
type DownloadLink struct {
	URL   string `json:"url"`
	Label string `json:"label,omitempty"`
}

// MapEntry is the full per-map record: metadata + page content sections.
type MapEntry struct {
	Name            string         `json:"name"`
	Author          string         `json:"author,omitempty"`
	BspNames        []string       `json:"bsp,omitempty"`
	ReleaseDate     string         `json:"release_date,omitempty"`
	OriginalRelease string         `json:"original_release,omitempty"`
	Difficulty      string         `json:"difficulty,omitempty"`
	Size            string         `json:"size,omitempty"`
	Rating          float64        `json:"rating"`
	Tags            []string       `json:"tags,omitempty"`
	Screenshots     []string       `json:"screenshots,omitempty"` // full-size URLs, hotlinked from scmapdb.wdfiles.com
	Summary         string         `json:"summary,omitempty"`     // plain text, for search
	Description     string         `json:"description,omitempty"` // sanitized HTML
	Additional      string         `json:"additional,omitempty"`  // sanitized HTML
	KnownIssues     string         `json:"known_issues,omitempty"`
	DownloadURL     string         `json:"download_url,omitempty"`
	Mirrors         []DownloadLink `json:"mirrors,omitempty"` // additional working download links
	URL             string         `json:"url"`
}

func main() {
	log.Println("SCMapDB Static Site Generator starting...")
	os.RemoveAll("pages") // legacy output, no longer generated

	slugs, err := fetchAllSlugs()
	if err != nil {
		log.Fatalf("Failed to fetch map list: %v", err)
	}

	log.Printf("Found %d unique map links", len(slugs))
	maps := scrapeAll(slugs)
	log.Printf("Parsed %d map pages", len(maps))
	log.Printf("Download links: %d checked, %d dead dropped",
		linksChecked.Load(), linksDead.Load())

	sort.Slice(maps, func(i, j int) bool {
		a, b := maps[i], maps[j]
		if a.Rating != b.Rating {
			return a.Rating > b.Rating
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an != bn {
			return an < bn
		}
		return a.URL < b.URL
	})

	if err := writeJSON(maps); err != nil {
		log.Fatalf("Failed to write maps.json: %v", err)
	}

	if err := writeHTML(maps); err != nil {
		log.Fatalf("Failed to write index.html: %v", err)
	}

	fmt.Printf("✓ maps.json + index.html: %d maps, all data embedded inline\n", len(maps))
}

// scrapeAll fetches and parses every slug with 6 parallel workers.
// Results are written to their index position, so output order is
// deterministic regardless of network timing.
func scrapeAll(slugs []string) []MapEntry {
	entries := make([]MapEntry, len(slugs))
	var next, done atomic.Int64
	var wg sync.WaitGroup
	for range 6 {
		wg.Go(func() {
			for {
				i := next.Add(1) - 1
				if i >= int64(len(slugs)) {
					return
				}

				entries[i] = scrapeMap(slugs[i])
				if d := done.Add(1); d%200 == 0 {
					log.Printf("Processed %d/%d", d, len(slugs))
				}
			}
		})
	}
	wg.Wait()

	var maps []MapEntry
	for i, e := range entries {
		if e.Name == "" {
			log.Printf("Skipping %s (no name parsed)", slugs[i])
			continue
		}

		maps = append(maps, e)
	}

	return maps
}

func writeJSON(maps []MapEntry) error {
	data, err := json.MarshalIndent(maps, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile("maps.json", data, 0644)
}

func writeHTML(maps []MapEntry) error {
	tmpl, err := template.ParseFiles(layout)
	if err != nil {
		return err
	}

	out, err := os.Create(output)
	if err != nil {
		return err
	}
	defer out.Close()

	return tmpl.Execute(out, struct {
		Title string
		Maps  []MapEntry
	}{title, maps})
}

// fetchPage GETs baseURL+path and returns the body.
func fetchPage(path string) ([]byte, error) {
	req, _ := http.NewRequest("GET", baseURL+path, nil)
	req.Header.Set("User-Agent", "SCMapDB-Static-Generator/1.0")
	resp, err := pageClient.Do(req)
	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d for %s", resp.StatusCode, path)
	}

	return io.ReadAll(resp.Body)
}

// fetchPageRetry GETs a path, retrying transient failures once after 1s.
func fetchPageRetry(path string) ([]byte, error) {
	var err error
	for attempt := range 2 {
		if attempt > 0 {
			time.Sleep(time.Second)
		}
		var body []byte
		if body, err = fetchPage(path); err == nil {
			return body, nil
		}
	}
	
	return nil, err
}

// fetchAllSlugs crawls /tag:all with pagination and returns every unique map slug.
func fetchAllSlugs() ([]string, error) {
	seen := make(map[string]bool)
	var slugs []string
	add := func(page []byte) {
		for _, s := range slugRe.FindAllString(string(page), -1) {
			if !seen[s] {
				seen[s] = true
				slugs = append(slugs, s)
			}
		}
	}

	page1, err := fetchPageRetry(indexURL)
	if err != nil {
		return nil, err
	}

	add(page1)

	maxPage := 1
	for _, m := range pageNumRe.FindAllStringSubmatch(string(page1), -1) {
		if n, perr := strconv.Atoi(m[1]); perr == nil && n > maxPage {
			maxPage = n
		}
	}

	log.Printf("Crawling %d tag pages...", maxPage)

	for p := 2; p <= maxPage; p++ {
		page, err := fetchPageRetry(fmt.Sprintf("%s/p/%d", indexURL, p))
		if err != nil {
			log.Printf("Warning: page %d failed: %v", p, err)
			continue
		}
		add(page)
	}

	return slugs, nil
}

// scrapeMap fetches one map page and extracts metadata + content sections.
func scrapeMap(slug string) MapEntry {
	pageURL := baseURL + slug

	body, err := fetchPageRetry(slug)
	if err != nil {
		log.Printf("Error fetching %s: %v", pageURL, err)
		return MapEntry{URL: pageURL}
	}
	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		log.Printf("Error parsing %s: %v", pageURL, err)
		return MapEntry{URL: pageURL}
	}

	entry := MapEntry{URL: pageURL}
	// Name: <title> is "Map Name - Sven Co-op Map Database"; strip the
	// fixed suffix rather than splitting on "-" (map names contain hyphens).
	if title := strings.TrimSpace(doc.Find("title").First().Text()); title != "" {
		if name, ok := strings.CutSuffix(title, pageTitleSuffix); ok {
			entry.Name = strings.TrimSpace(name)
		} else if i := strings.LastIndex(title, " - "); i > 0 {
			entry.Name = strings.TrimSpace(title[:i])
		} else {
			entry.Name = title
		}
	}
	// Metadata table: author, release dates, .bsp filenames
	var author, projectLead, team string
	doc.Find("table.wiki-content-table tr").Each(func(i int, tr *goquery.Selection) {
		tds := tr.Find("td")
		if tds.Length() < 2 {
			return
		}
		label := strings.ToLower(strings.TrimSpace(tds.First().Text()))
		val := strings.TrimSpace(tds.Last().Text())
		switch {
		case containsAny(label, "author", "mapper", "creator", "developer"):
			author = val
		case strings.Contains(label, "project lead"):
			projectLead = val
		case strings.Contains(label, "team"):
			team = val
		case strings.Contains(label, "original mod release"):
			entry.OriginalRelease = val
		case strings.Contains(label, "date of release"):
			entry.ReleaseDate = val
		case strings.Contains(label, "bsp filename"):
			entry.BspNames = splitList(val)
		}
	})

	entry.Author = firstNonEmpty(author, projectLead, team, "Unknown")
	entry.Description = sectionHTML(doc, "description")
	entry.Additional = sectionHTML(doc, "additional info")
	entry.KnownIssues = htmlToText(sectionHTML(doc, "known issues"), 1000)
	entry.Screenshots = extractScreenshots(doc, slug)
	// Rating: <div class="page-rate-widget-start" data-rating="2">
	if r := doc.Find("div.page-rate-widget-start").First(); r.Length() > 0 {
		if v, ok := r.Attr("data-rating"); ok {
			if f, perr := strconv.ParseFloat(v, 64); perr == nil {
				entry.Rating = f
			}
		}
	}
	// Tags; difficulty and size live in namespaced tags
	entry.Tags = extractTags(doc)
	for _, t := range entry.Tags {
		switch {
		case strings.HasPrefix(t, "difficulty:"):
			entry.Difficulty = strings.TrimPrefix(t, "difficulty:")
		case strings.HasPrefix(t, "size:"):
			entry.Size = strings.TrimPrefix(t, "size:")
		}
	}
	// Download links: extract with labels, keep only the working ones.
	// First survivor is the primary; the rest are listed as mirrors.
	candidates := extractDownloads(doc)
	var alive []DownloadLink
	for _, l := range candidates {
		if checkAlive(l.URL) {
			alive = append(alive, l)
		}
	}

	if len(alive) > 0 {
		entry.DownloadURL = alive[0].URL
		entry.Mirrors = alive[1:]
	}

	entry.Summary = htmlToText(entry.Description+" "+entry.Additional, 300)
	if entry.Summary == "" {
		if pc := doc.Find("#page-content"); pc.Length() > 0 {
			entry.Summary = boundText(strings.Join(strings.Fields(pc.Text()), " "), 300)
		}
	}

	return entry
}

// containsAny reports whether s contains any of the given substrings.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	
	return false
}

// splitList splits a comma-separated value into trimmed, non-empty parts.
func splitList(val string) []string {
	var out []string
	for _, p := range strings.Split(val, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// sectionHTML captures the HTML of sibling elements following the first
// heading whose text contains headingText, up to the next heading.
func sectionHTML(doc *goquery.Document, headingText string) string {
	var header *goquery.Selection
	doc.Find("h2, h3").Each(func(i int, s *goquery.Selection) {
		if header == nil && strings.Contains(strings.ToLower(s.Text()), headingText) {
			header = s
		}
	})

	if header == nil {
		return ""
	}

	var buf strings.Builder
	for next := header.Next(); next.Length() > 0 && !next.Is("h1, h2, h3"); next = next.Next() {
		clone := next.Clone()
		sanitise(clone)
		if h, err := goquery.OuterHtml(clone); err == nil {
			buf.WriteString(h)
		}
	}

	return strings.TrimSpace(buf.String())
}

// htmlToText converts HTML to a bounded plain-text teaser ("" if empty).
func htmlToText(htmlStr string, max int) string {
	if strings.TrimSpace(htmlStr) == "" {
		return ""
	}
	d, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return ""
	}
	return boundText(strings.Join(strings.Fields(d.Text()), " "), max)
}

// boundText truncates to at most max runes, adding an ellipsis.
func boundText(s string, max int) string {
	s = strings.TrimSpace(s)
	if runes := []rune(s); len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return s
}

// firstNonEmpty returns the first non-empty string, or the last fallback.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return vals[len(vals)-1]
}

// sanitise strips attributes that could bleed styling or execute code.
// Removes script/iframe/style/link/object/embed entirely; keeps only
// a[href] (made absolute, plus target/rel) and img[src,alt] (src absolute).
func sanitise(sel *goquery.Selection) {
	sel.Find("script, iframe, style, link, object, embed").Remove()

	sel.Find("*").Each(func(_ int, el *goquery.Selection) {
		for _, node := range el.Nodes {
			if node.Type != html.ElementNode {
				continue
			}

			switch node.Data {
			case "a":
				kept := make([]html.Attribute, 0, 3)
				for _, attr := range node.Attr {
					if attr.Key == "href" && attr.Val != "" && safeURL(attr.Val) {
						attr.Val = absolutise(attr.Val)
						kept = append(kept, attr)
					}
				}
				kept = append(kept,
					html.Attribute{Key: "target", Val: "_blank"},
					html.Attribute{Key: "rel", Val: "noopener noreferrer"})
				node.Attr = kept

			case "img":
				kept := make([]html.Attribute, 0, 2)
				for _, attr := range node.Attr {
					switch attr.Key {
					case "src":
						if !safeURL(attr.Val) {
							continue
						}
						attr.Val = absolutise(attr.Val)
						kept = append(kept, attr)
					case "alt":
						kept = append(kept, attr)
					}
				}
				node.Attr = kept

			default:
				node.Attr = nil
			}
		}
	})
}

// absolutise makes a wiki-relative URL absolute.
func absolutise(u string) string {
	if strings.HasPrefix(u, "/") {
		return baseURL + u
	}

	return u
}

// safeURL reports whether u is safe to keep as a link/image target:
// absolute http(s), same-site relative, or plain relative reference.
// Anything else (javascript:, data:, mailto:, scheme-relative //host, ...)
// is rejected.
func safeURL(u string) bool {
	s := strings.ToLower(strings.TrimSpace(u))
	switch {
	case strings.HasPrefix(s, "http://"), strings.HasPrefix(s, "https://"):
		return true
	case strings.HasPrefix(s, "//"):
		return false
	case strings.HasPrefix(s, "/"), strings.HasPrefix(s, "#"):
		return true
	}

	return !strings.Contains(s, ":")
}

// extractScreenshots collects full-size image URLs for the map's gallery.
// Primary source: anchors inside .gallery-item; fallback: <img> tags in the
// page content (resized URLs upgraded to full size). URLs are filtered to
// those mentioning the map id, with the unfiltered gallery as last resort.
func extractScreenshots(doc *goquery.Document, slug string) []string {
	id := strings.ToLower(strings.TrimPrefix(slug, "/map:"))
	id = strings.ReplaceAll(id, ":", "-")
	compact := strings.ReplaceAll(id, "-", "")
	hasID := func(u string) bool {
		lu := strings.ToLower(u)
		return strings.Contains(lu, id) || strings.Contains(lu, compact)
	}
	// upgradeResized turns a resized-image URL into its full-size equivalent:
	// .../local--resized-images/map:foo/img.jpg/medium.jpg -> .../local--files/map:foo/img.jpg
	upgradeResized := func(u string) string {
		const resized = "/local--resized-images/"
		before, after, ok := strings.Cut(u, resized)
		if !ok {
			return u
		}

		if j := strings.LastIndex(after, "/"); j != -1 {
			after = after[:j]
		}

		return before + "/local--files/" + after
	}

	var gallery, content []string
	gallerySeen := make(map[string]bool)
	contentSeen := make(map[string]bool)

	doc.Find(".gallery-item a[href]").Each(func(_ int, a *goquery.Selection) {
		href, ok := a.Attr("href")
		if !ok || !imageRe.MatchString(href) {
			return
		}

		href = absolutise(href)
		if !gallerySeen[href] {
			gallerySeen[href] = true
			gallery = append(gallery, href)
		}
	})

	doc.Find("#page-content img[src]").Each(func(_ int, img *goquery.Selection) {
		src, ok := img.Attr("src")
		if !ok || !strings.Contains(src, "wdfiles") || !imageRe.MatchString(src) {
			return
		}

		full := absolutise(upgradeResized(src))
		if !contentSeen[full] {
			contentSeen[full] = true
			content = append(content, full)
		}
	})

	filter := func(urls []string) []string {
		var out []string
		for _, u := range urls {
			if hasID(u) {
				out = append(out, u)
			}
		}

		return out
	}

	if result := filter(gallery); len(result) > 0 {
		return result
	}

	if result := filter(content); len(result) > 0 {
		return result
	}

	return gallery // slug filter too strict for this page; keep gallery as-is
}

// extractTags pulls wiki tags from /tag: links, URL-decoding %3A.
func extractTags(doc *goquery.Document) []string {
	var tags []string
	seen := make(map[string]bool)

	doc.Find(`a[href^="/tag:"]`).Each(func(i int, s *goquery.Selection) {
		href, ok := s.Attr("href")
		if !ok {
			return
		}

		href = strings.TrimPrefix(href, "/tag:")
		if decoded, err := url.PathUnescape(href); err == nil {
			href = decoded
		}

		if href == "all" || strings.HasPrefix(href, "all:") || href == "edit" || href == "needs-pics" {
			return
		}

		if !seen[href] {
			seen[href] = true
			tags = append(tags, href)
		}
	})

	return tags
}

// extractDownloads collects every archive link on the page, deduped in
// document order, each labeled by its surrounding text.
func extractDownloads(doc *goquery.Document) []DownloadLink {
	var links []DownloadLink
	seen := make(map[string]bool)
	doc.Find("a[href]").Each(func(_ int, a *goquery.Selection) {
		href, ok := a.Attr("href")
		if !ok || !archiveRe.MatchString(href) {
			return
		}

		href = absolutise(href)
		if seen[href] {
			return
		}

		seen[href] = true
		links = append(links, DownloadLink{URL: href, Label: linkLabel(a, href)})
	})

	return links
}

// linkLabel derives a human-readable label for a download link: the text
// preceding the link inside its parent ("Community edit:"), falling back
// to the anchor text ("SCMapDB"), then the URL's host name.
func linkLabel(a *goquery.Selection, href string) string {
	if len(a.Nodes) == 0 {
		return ""
	}

	self := a.Nodes[0]
	var before []string
	for child := self.Parent.FirstChild; child != nil; child = child.NextSibling {
		if child == self {
			break
		}

		if child.Type == html.TextNode {
			if t := strings.TrimSpace(child.Data); t != "" {
				before = append(before, t)
			}
		}
	}

	if label := strings.Join(before, " "); label != "" {
		return strings.TrimSuffix(strings.TrimSpace(label), ":")
	}

	if t := strings.TrimSpace(a.Text()); t != "" {
		return t
	}

	if u, err := url.Parse(href); err == nil {
		return u.Hostname()
	}

	return ""
}

// checkAlive reports whether a download URL responds successfully.
// Uses HEAD request first, falls back to ranged GET if needed; 404/410 are
// final verdicts, transient failures retry once with 1s delay before drop.
func checkAlive(raw string) bool {
	linksChecked.Add(1)
	for attempt := range 2 {
		if attempt > 0 {
			time.Sleep(time.Second)
		}

		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			linksDead.Add(1)
			return false
		}

		req, err := http.NewRequest(http.MethodHead, raw, nil)
		if err != nil {
			linksDead.Add(1)
			return false
		}

		req.Header.Set("User-Agent", "SCMapDB-Static-Generator/1.0")
		resp, err := dlClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 400 {
				return true
			}

			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				linksDead.Add(1)
				return false
			}

			if resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusForbidden {
				// HEAD not supported; try ranged GET below
			} else {
				linksDead.Add(1)
				return false
			}
		}
		// ranged GET fallback for servers that reject HEAD
		req, _ = http.NewRequest(http.MethodGet, raw, nil)
		req.Header.Set("User-Agent", "SCMapDB-Static-Generator/1.0")
		req.Header.Set("Range", "bytes=0-0")
		resp, err = dlClient.Do(req)
		if err != nil {
			continue
		}

		defer resp.Body.Close()
		io.CopyN(io.Discard, resp.Body, 1)

		switch {
		case resp.StatusCode >= 200 && resp.StatusCode < 400:
			return true

		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			linksDead.Add(1)
			return false

		default:
			continue
		}
	}

	linksDead.Add(1)
	return false
}
