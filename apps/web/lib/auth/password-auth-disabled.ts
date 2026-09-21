import type { NextApiRequest, NextApiResponse } from "next";

// Keep legacy routes closed even when called directly, without rendering a page.
export default function passwordAuthDisabled(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }
  return res.status(403).json({
    message: "Password authentication is disabled. Use Google sign-in.",
  });
}
