import Link from "next/link";

import { useIsEmbed } from "@calcom/embed-core/embed-iframe";
import { POWERED_BY_URL } from "@calcom/lib/constants";

const PoweredByCal = () => {
  const isEmbed = useIsEmbed();
  return (
    <div className={"p-2 text-center text-xs sm:text-center" + (isEmbed ? " max-w-3xl" : "")}>
      <Link href={POWERED_BY_URL}>
        <a target="_blank" className="text-bookinglight dark:text-white">
          {
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className=" mt-px inline h-28 w-auto dark:hidden"
              src="https://vwo.com/downloads/media-kit/VWO-Logo-Color.svg"
              alt="vwo.com Logo"
            />
          }
          {
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className=" mt-px hidden h-28 w-auto dark:inline"
              src="https://vwo.com/downloads/media-kit/VWO-Logo-White.svg"
              alt="vwo.com Logo"
            />
          }
        </a>
      </Link>
    </div>
  );
};

export default PoweredByCal;
