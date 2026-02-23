package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// handleGraylogLogs proxies a log search to Graylog for a given VM hostname.
//
// GET /api/graylog/logs?vm=<hostname>&limit=<n>
//
// Required env vars:
//
//	GRAYLOG_URL      – base URL, e.g. http://192.168.100.30:9000
//	GRAYLOG_API_USER – Graylog username
//	GRAYLOG_API_PASS – Graylog password
func (r *Router) handleGraylogLogs(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// --- env config ---
	baseURL := os.Getenv("GRAYLOG_URL")
	user := os.Getenv("GRAYLOG_API_USER")
	pass := os.Getenv("GRAYLOG_API_PASS")
	if baseURL == "" || user == "" || pass == "" {
		http.Error(w, "Graylog not configured (set GRAYLOG_URL / GRAYLOG_API_USER / GRAYLOG_API_PASS)", http.StatusServiceUnavailable)
		return
	}

	// --- request params ---
	vmName := req.URL.Query().Get("vm")
	if vmName == "" {
		http.Error(w, "vm parameter is required", http.StatusBadRequest)
		return
	}

	// --- build Graylog Views API request body ---
	body := map[string]interface{}{
		"query_string": fmt.Sprintf("source:%s", vmName),
		"timerange": map[string]interface{}{
			"type":  "relative",
			"range": 3600,
		},
		"chunk_size":      100,
		"fields_in_order": []string{"timestamp", "message"},
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to marshal request body")
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	graylogURL := baseURL + "/api/views/search/messages"

	client := &http.Client{Timeout: 10 * time.Second}
	graylogReq, err := http.NewRequest(http.MethodPost, graylogURL, bytes.NewReader(bodyBytes))
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to build request")
		http.Error(w, "Failed to build Graylog request", http.StatusInternalServerError)
		return
	}
	graylogReq.SetBasicAuth(user, pass)
	graylogReq.Header.Set("Content-Type", "application/json")
	graylogReq.Header.Set("X-Requested-By", "pulse")

	resp, err := client.Do(graylogReq)
	if err != nil {
		log.Error().Err(err).Str("vm", vmName).Msg("graylog: request failed")
		http.Error(w, "Failed to reach Graylog", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		log.Error().Int("status", resp.StatusCode).Str("body", string(raw)).Str("vm", vmName).Msg("graylog: unexpected status")
		http.Error(w, fmt.Sprintf("Graylog returned HTTP %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	// --- just pass through the raw response ---
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to read response body")
		http.Error(w, "Failed to read Graylog response", http.StatusInternalServerError)
		return
	}

	limit := 100
	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	lines := strings.Split(string(raw), "\n")
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	if limit < len(lines) {
		lines = lines[:limit]
	}
	result := strings.Join(lines, "\n")

	// Log the raw response for debugging
	// log.Info().Str("vm", vmName).Str("raw_response", string(raw)).Msg("graylog: raw response")

	// Return raw CSV to frontend
	w.Header().Set("Content-Type", "text/csv")
	//w.Write(raw)
	w.Write([]byte(result))
}
