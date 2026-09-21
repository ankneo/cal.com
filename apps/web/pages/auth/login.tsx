import { GetServerSidePropsContext } from "next";
import { signIn } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import { FaGoogle } from "react-icons/fa";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Alert } from "@calcom/ui/Alert";
import { Button } from "@calcom/ui/v2";

import { getSession } from "@lib/auth";
import { inferSSRProps } from "@lib/types/inferSSRProps";

import AddToHomescreen from "@components/AddToHomescreen";
import AuthContainer from "@components/v2/ui/AuthContainer";

import { IS_GOOGLE_LOGIN_ENABLED } from "@server/lib/constants";
import { ssrInit } from "@server/lib/ssr";

export default function Login({ isGoogleLoginEnabled }: inferSSRProps<typeof getServerSideProps>) {
  const { t } = useLocale();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  let callbackUrl = WEBAPP_URL;
  if (typeof router.query.callbackUrl === "string") {
    try {
      const target = new URL(router.query.callbackUrl, WEBAPP_URL);
      if (target.origin === new URL(WEBAPP_URL).origin) callbackUrl = target.href;
    } catch {
      // Invalid destinations fall back to the application home page.
    }
  }

  return (
    <>
      <AuthContainer title={t("login")} description={t("login")} showLogo heading={t("welcome_back")}>
        {isGoogleLoginEnabled ? (
          <div className="space-y-4">
            {(failed || router.query.error) && <Alert severity="error" title={t("error_during_login")} />}
            <Button
              color="secondary"
              className="w-full justify-center"
              data-testid="google"
              StartIcon={FaGoogle}
              disabled={isSubmitting}
              onClick={async () => {
                setIsSubmitting(true);
                setFailed(false);
                try {
                  await signIn("google", { callbackUrl });
                } catch {
                  setFailed(true);
                  setIsSubmitting(false);
                }
              }}>
              {t("signin_with_google")}
            </Button>
          </div>
        ) : (
          <Alert severity="error" title="Google sign-in is unavailable. Please contact your administrator." />
        )}
      </AuthContainer>
      <AddToHomescreen />
    </>
  );
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getSession({ req: context.req });
  if (session) return { redirect: { destination: "/", permanent: false } };

  const ssr = await ssrInit(context);
  return {
    props: {
      trpcState: ssr.dehydrate(),
      isGoogleLoginEnabled: IS_GOOGLE_LOGIN_ENABLED,
    },
  };
}
