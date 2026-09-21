import { IdentityProvider, UserPermissionRole } from "@prisma/client";
import NextAuth, { Session } from "next-auth";
import { Provider } from "next-auth/providers";
import GoogleProvider from "next-auth/providers/google";

import checkLicense from "@calcom/features/ee/common/server/checkLicense";
import ImpersonationProvider from "@calcom/features/ee/impersonation/lib/ImpersonationProvider";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { defaultCookies } from "@calcom/lib/default-cookies";
import prisma from "@calcom/prisma";

import CalComAdapter from "@lib/auth/next-auth-custom-adapter";
import { hostedCal } from "@lib/saml";

import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, IS_GOOGLE_LOGIN_ENABLED } from "@server/lib/constants";

const usernameSlug = (username: string) => username.toLowerCase().split("@")[0];

// Google is the only public sign-in method. Impersonation keeps its existing
// session authorization, target opt-out checks, and audit logging.
const providers: Provider[] = [ImpersonationProvider];
if (IS_GOOGLE_LOGIN_ENABLED) {
  providers.push(GoogleProvider({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }));
}

const calcomAdapter = CalComAdapter(prisma);
export default NextAuth({
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  adapter: calcomAdapter,
  session: {
    strategy: "jwt",
  },
  cookies: defaultCookies(WEBAPP_URL?.startsWith("https://")),
  pages: {
    signIn: "/auth/login",
    signOut: "/auth/logout",
    error: "/auth/error", // Error code passed in query string as ?error=
    // newUser: "/auth/new", // New users will be directed here on first sign in (leave the property out if not of interest)
  },
  providers,
  callbacks: {
    async jwt({ token, user, account }) {
      const autoMergeIdentities = async () => {
        const existingUser = await prisma.user.findFirst({
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          where: { email: token.email! },
        });

        if (!existingUser) {
          return token;
        }

        return {
          id: existingUser.id,
          username: existingUser.username,
          name: existingUser.name,
          email: existingUser.email,
          role: existingUser.role,
          impersonatedByUID: token?.impersonatedByUID as number,
        };
      };
      if (!user) {
        return await autoMergeIdentities();
      }

      if (account?.type === "credentials" && account.provider === "impersonation-auth") {
        return {
          id: user.id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role,
          impersonatedByUID: user.impersonatedByUID as number,
        };
      }

      // The arguments above are from the provider so we need to look up the
      // user based on those values in order to construct a JWT.
      if (account && account.type === "oauth" && account.provider && account.providerAccountId) {
        const idP = IdentityProvider.GOOGLE;
        const existingUser = await prisma.user.findFirst({
          where: {
            AND: [
              {
                identityProvider: idP,
              },
              {
                identityProviderId: account.providerAccountId as string,
              },
            ],
          },
        });

        if (!existingUser) {
          return await autoMergeIdentities();
        }

        return {
          id: existingUser.id,
          name: existingUser.name,
          username: existingUser.username,
          email: existingUser.email,
          role: existingUser.role,
          impersonatedByUID: token.impersonatedByUID as number,
        };
      }

      return token;
    },
    async session({ session, token }) {
      const hasValidLicense = await checkLicense(process.env.CALCOM_LICENSE_KEY || "");
      const calendsoSession: Session = {
        ...session,
        hasValidLicense,
        user: {
          ...session.user,
          id: token.id as number,
          name: token.name,
          username: token.username as string,
          role: token.role as UserPermissionRole,
          impersonatedByUID: token.impersonatedByUID as number,
        },
      };
      return calendsoSession;
    },
    async signIn(params) {
      const { user, account, profile } = params;

      // This provider authorizes an existing session before reaching signIn.
      // Do not permit a generic credentials/password sign-in here.
      if (account.type === "credentials" && account.provider === "impersonation-auth") {
        return true;
      }
      if (account.type !== "oauth" || account.provider !== "google") {
        return false;
      }
      // Trust verification from the current Google response, not a stored flag.
      if (profile?.email_verified !== true) {
        return "/auth/error?error=unverified-email";
      }

      if (!user.email) {
        return false;
      }

      if (!user.name) {
        return false;
      }

      if (account.provider) {
        const idP = IdentityProvider.GOOGLE;
        // Only google oauth on this path
        const provider = account.provider.toUpperCase() as IdentityProvider;

        const existingUser = await prisma.user.findFirst({
          include: {
            accounts: {
              where: {
                provider: account.provider,
              },
            },
          },
          where: {
            identityProvider: provider,
            identityProviderId: account.providerAccountId,
          },
        });

        if (existingUser) {
          // In this case there's an existing user and their email address
          // hasn't changed since they last logged in.
          if (existingUser.email === user.email) {
            try {
              // If old user without Account entry we link their google account
              if (existingUser.accounts.length === 0) {
                const linkAccountWithUserData = { ...account, userId: existingUser.id };
                await calcomAdapter.linkAccount(linkAccountWithUserData);
              }
            } catch (error) {
              if (error instanceof Error) {
                console.error("Error while linking account of already existing user");
              }
            }
            return true;
          }

          // If the email address doesn't match, check if an account already exists
          // with the new email address. If it does, for now we return an error. If
          // not, update the email of their account and log them in.
          const userWithNewEmail = await prisma.user.findFirst({
            where: { email: user.email },
          });

          if (!userWithNewEmail) {
            await prisma.user.update({ where: { id: existingUser.id }, data: { email: user.email } });
            return true;
          } else {
            return "/auth/error?error=new-email-conflict";
          }
        }

        // If there's no existing user for this identity provider and id, create
        // a new account. If an account already exists with the incoming email
        // address return an error for now.
        const existingUserWithEmail = await prisma.user.findFirst({
          where: { email: user.email },
        });

        if (existingUserWithEmail) {
          // if self-hosted then we can allow auto-merge of identity providers if email is verified
          if (hostedCal && existingUserWithEmail.emailVerified) {
            return true;
          }

          // check if user was invited
          if (
            !existingUserWithEmail.password &&
            !existingUserWithEmail.emailVerified &&
            !existingUserWithEmail.username
          ) {
            await prisma.user.update({
              where: { email: user.email },
              data: {
                // Slugify the incoming name and append a few random characters to
                // prevent conflicts for users with the same name.
                username: usernameSlug(user.email),
                emailVerified: new Date(Date.now()),
                name: user.name,
                identityProvider: idP,
                identityProviderId: user.id as string,
              },
            });

            return true;
          }

          if (existingUserWithEmail.identityProvider === IdentityProvider.CAL) {
            return "/auth/error?error=google-account-link-required";
          }

          return "/auth/error?error=use-identity-login";
        }

        const newUser = await prisma.user.create({
          data: {
            // Slugify the incoming name and append a few random characters to
            // prevent conflicts for users with the same name.
            username: usernameSlug(user.email),
            emailVerified: new Date(Date.now()),
            name: user.name,
            email: user.email,
            identityProvider: idP,
            identityProviderId: user.id as string,
          },
        });
        const linkAccountNewUserData = { ...account, userId: newUser.id };
        await calcomAdapter.linkAccount(linkAccountNewUserData);

        return true;
      }

      return false;
    },
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Allows callback URLs on the same domain
      else if (new URL(url).hostname === new URL(WEBAPP_URL).hostname) return url;
      return baseUrl;
    },
  },
});
