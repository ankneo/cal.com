import { z } from "zod";

import { verifyPassword } from "@calcom/lib/auth";
import prisma from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import { createProtectedRouter } from "../../createRouter";

export const authRouter = createProtectedRouter()
  .mutation("changePassword", {
    input: z.object({
      oldPassword: z.string(),
      newPassword: z.string(),
    }),
    async resolve() {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Password authentication is disabled. Use Google sign-in.",
      });
    },
  })
  .mutation("verifyPassword", {
    input: z.object({
      passwordInput: z.string(),
    }),
    async resolve({ input, ctx }) {
      const user = await prisma.user.findUnique({
        where: {
          id: ctx.user.id,
        },
      });

      if (!user?.password) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }

      const passwordsMatch = await verifyPassword(input.passwordInput, user.password);

      if (!passwordsMatch) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      return;
    },
  });
