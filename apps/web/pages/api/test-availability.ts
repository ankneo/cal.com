import type { NextApiRequest, NextApiResponse } from "next";

import { getSession } from "@lib/auth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession({ req });

  if (!session?.user?.id) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  if (session.user.role !== "ADMIN") {
    res.status(403).json({ message: "Not authorized" });
    return;
  }

  if (req.method === "GET") {
    // Return a simple test response
    res.status(200).json({
      message: "Availability dashboard is working",
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role,
      },
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(405).json({ message: "Method not allowed" });
  }
}
