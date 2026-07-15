import { handleGatewayRequest } from "../server.mjs";

export const maxDuration = 60;

export default async function handler(request, response) {
  const route = request.method === "GET" ? "/health" : "/v1/insights";
  return handleGatewayRequest(request, response, route);
}
