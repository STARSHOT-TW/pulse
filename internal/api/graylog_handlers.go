package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/rs/zerolog/log"
)

// graylogMessage is what we send to the frontend for each log entry.
type graylogMessage struct {
	Timestamp string `json:"timestamp"`
	Source    string `json:"source"`
	Message   string `json:"message"`
	Level     string `json:"level"`
}

// graylogLogsResponse is the full response returned to the frontend.
type graylogLogsResponse struct {
	Logs  []graylogMessage `json:"logs"`
	Count int              `json:"count"`
	VM    string           `json:"vm"`
}

// graylogScriptingResponse is the JSON shape returned by
// POST /api/search/messages with Accept: application/json (Graylog 7.x).
//
//	{
//	  "schema":   [ {"field":"timestamp",...}, ... ],
//	  "datarows": [ ["2025-01-01T...", "ubuntu", "kernel: ...", "6"], ... ],
//	  "metadata": { ... }
//	}
type graylogScriptingResponse struct {
	Schema []struct {
		Field string `json:"field"`
	} `json:"schema"`
	Datarows [][]interface{} `json:"datarows"`
}

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

	limit := 10
	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	// --- build Graylog scripting API request body ---
	// POST /api/search/messages (Graylog 7.x scripting API)
	// Newest-first: sort by timestamp desc.
	body := map[string]interface{}{
		"query_string": fmt.Sprintf("source:%s", vmName),
		"timerange": map[string]interface{}{
			"type":  "relative",
			"range": 86400, // last 24 h
		},
		"fields_in_order": []string{"timestamp", "source", "message", "level"},
		"sort":            "timestamp",
		"sort_order":      "desc",
		"limit":           limit,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to marshal request body")
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	client := &http.Client{Timeout: 10 * time.Second}
	graylogReq, err := http.NewRequest(http.MethodPost, baseURL+"/api/search/messages", bytes.NewReader(bodyBytes))
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to build request")
		http.Error(w, "Failed to build Graylog request", http.StatusInternalServerError)
		return
	}
	graylogReq.SetBasicAuth(user, pass)
	graylogReq.Header.Set("Content-Type", "application/json")
	graylogReq.Header.Set("Accept", "application/json")
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
		log.Error().Int("status", resp.StatusCode).Str("body", string(raw)).Msg("graylog: unexpected status")
		http.Error(w, fmt.Sprintf("Graylog returned HTTP %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	// --- parse Graylog 7.x scripting API response ---
	// Response shape: { schema: [{field, name, ...}], datarows: [[v0,v1,...], ...] }
	// Values in each datarow correspond positionally to schema entries.
	var scriptResp graylogScriptingResponse
	if err := json.NewDecoder(resp.Body).Decode(&scriptResp); err != nil {
		log.Error().Err(err).Msg("graylog: failed to decode response")
		http.Error(w, "Failed to parse Graylog response", http.StatusInternalServerError)
		return
	}

	// Build field → column index map
	colIndex := make(map[string]int, len(scriptResp.Schema))
	for i, col := range scriptResp.Schema {
		colIndex[col.Field] = i
	}

	str := func(row []interface{}, field string) string {
		idx, ok := colIndex[field]
		if !ok || idx >= len(row) {
			return ""
		}
		if s, ok := row[idx].(string); ok {
			return s
		}
		return fmt.Sprintf("%v", row[idx])
	}

	logs := make([]graylogMessage, 0, len(scriptResp.Datarows))
	for _, row := range scriptResp.Datarows {
		logs = append(logs, graylogMessage{
			Timestamp: str(row, "timestamp"),
			Source:    str(row, "source"),
			Message:   str(row, "message"),
			Level:     str(row, "level"),
		})
	}

	out := graylogLogsResponse{Logs: logs, Count: len(logs), VM: vmName}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(out); err != nil {
		log.Error().Err(err).Msg("graylog: failed to write response")
	}
}
