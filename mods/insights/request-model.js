// Keep the visible model and the model filter on the same recorded value.
export function requestModel(row) {
  for (const value of [row?.requestedModel, row?.model, row?.reportedModel]) {
    if (typeof value === "string" && value.trim() && !["unknown", "unknown model", "—"].includes(value.trim())) return value.trim();
  }
  return null;
}
