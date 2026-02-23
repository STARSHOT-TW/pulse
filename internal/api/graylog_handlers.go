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

// graylogViewsResponse is the JSON shape returned by
// POST /api/views/search/messages (Graylog 7.x Views API).
//
// Example structure:
//
//	{
//	  "schema": [ {"field":"timestamp",...}, {"field":"source",...}, ... ],
//	  "datarows": [ ["2025-02-13T10:30:00.123Z", "ubuntu", "kernel: msg", "6"], ... ],
//	  "metadata": { ... }
//	}
type graylogViewsResponse struct {
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

	// --- build Graylog Views API request body ---
	// POST /api/views/search/messages (Graylog 7.x)
	// Match the exact structure from the working curl command.
	body := map[string]interface{}{
		"query_string": fmt.Sprintf("source:%s", vmName),
		"timerange": map[string]interface{}{
			"type":  "relative",
			"range": 86400, // last 24 hours in seconds
		},
		"limit":      limit,
		"chunk_size": limit,
		"fields_in_order": []string{"timestamp", "source", "message", "level"},
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		log.Error().Err(err).Msg("graylog: failed to marshal request body")
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	// Use the Views API endpoint: /api/views/search/messages
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

	// --- parse Graylog 7.x Views API response ---
	// Response shape: { schema: [{field}], datarows: [[v0,v1,v2,...], ...] }
	// Values in each datarow correspond positionally to schema fields.
	var viewsResp graylogViewsResponse
	if err := json.NewDecoder(resp.Body).Decode(&viewsResp); err != nil {
		log.Error().Err(err).Msg("graylog: failed to decode response")
		http.Error(w, "Failed to parse Graylog response", http.StatusInternalServerError)
		return
	}

	// Build field → column index map from schema
	colIndex := make(map[string]int, len(viewsResp.Schema))
	for i, col := range viewsResp.Schema {
		colIndex[col.Field] = i
	}

	// Helper to safely extract string value from a datarow
	str := func(row []interface{}, field string) string {
		idx, ok := colIndex[field]
		if !ok || idx >= len(row) {
			return ""
		}
		if s, ok := row[idx].(string); ok {
			return s
		}
		// Convert numbers or other types to string
		return fmt.Sprintf("%v", row[idx])
	}

	logs := make([]graylogMessage, 0, len(viewsResp.Datarows))
	for _, row := range viewsResp.Datarows {
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
