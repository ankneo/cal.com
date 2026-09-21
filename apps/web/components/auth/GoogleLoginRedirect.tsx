import type { GetServerSidePropsContext } from "next";

export default function GoogleLoginRedirect() {
  return null;
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const callbackUrl = context.query.callbackUrl;
  return {
    redirect: {
      destination:
        typeof callbackUrl === "string"
          ? `/auth/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
          : "/auth/login",
      permanent: false,
    },
  };
}
