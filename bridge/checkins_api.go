package main

import "net/http"

// GET /v1/devices/{id}/checkins: today's check-in state for this phone's check-ins (the app
// shows "First activity 7:42 AM · 23 moments").
func (h *hub) handleCheckinStates(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, ok := h.store.get(id)
	g := grantFrom(r)
	if !ok || (d.GrantID != g.ID && g.Role != roleOwner) {
		apiError(w, http.StatusNotFound, "not_found", "This phone isn't registered for alerts.")
		return
	}
	writeJSON(w, http.StatusOK, h.checkins.statesFor(d))
}

// POST /v1/devices/{id}/checkins/{cid}/ok: "Mom's fine" from the notification.
func (h *hub) handleCheckinOK(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, ok := h.store.get(id)
	g := grantFrom(r)
	if !ok || (d.GrantID != g.ID && g.Role != roleOwner) || !h.checkins.markOK(id, r.PathValue("cid")) {
		apiError(w, http.StatusNotFound, "not_found", "No such check-in on this phone.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// legacyCheckinOK is the same for the original X-Bridge-Secret API.
func legacyCheckinOK(h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h == nil || !h.checkins.markOK(r.PathValue("id"), r.PathValue("cid")) {
			http.Error(w, "unknown check-in", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
