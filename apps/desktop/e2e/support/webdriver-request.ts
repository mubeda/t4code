export function normalizeWebDriverRequest(request: RequestInit): RequestInit {
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  return {
    ...request,
    headers,
  };
}
