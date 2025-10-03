import Image from "next/image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <Card className="shadow-sm bg-muted px-4 w-[50vw] mx-auto mt-[10vh]">
      <CardHeader className="flex flex-row gap-2 px-0 items-center w-[80%]">
        <div className="rounded-full w-16 h-16 shrink-0 overflow-hidden mr-2">
          <Image
            src="/link-icon.jpg"
            alt="Proxy URL"
            width={120}
            height={120}
          />
        </div>
        <div>
          <CardTitle className="text-2xl font-bold">Proxy URL</CardTitle>
          <CardDescription className="text-md">
            Configure the endpoint for your LLM proxy
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Card>
          <CardContent>
            <code className="text-sm">http://localhost:9000</code>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
