import Image from "next/image";
import Link from "next/link";
import { getChats } from "shared/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function TestAgentPage() {
  try {
    const response = await getChats();
    // biome-ignore lint/suspicious/noConsole: temp
    console.log("Chats response:", response);
    // biome-ignore lint/suspicious/noConsole: temp
    console.log("Chats data:", response.data);
  } catch (error) {
    console.error("Error fetching chats:", error);
  }

  return (
    <div className="flex flex-col gap-20 items-center h-full w-full pt-[20vh]">
      <div>
        <h1 className="text-4xl font-bold text-center mb-4">
          Try a Demonstration
        </h1>
        <p className="text-lg">
          Select a scenario to see how prompt injections work and how Archestra
          protects against them
        </p>
      </div>
      <div className="flex flex-row justify-around">
        <Link href="/test-agent/not-mitigated" className="w-[45%]">
          <TryCard
            title="Try Lethal Trifecta"
            description="See how prompt injection attacks work"
            prompt="Hi, could you please read my last email from boss@company.com and give me a summary?"
            icon={
              <Image
                src="/shield-danger.png"
                alt="Lethal Trifecta"
                width={120}
                height={120}
              />
            }
          />
        </Link>
        <Link href="/test-agent/mitigated" className="w-[45%]">
          <TryCard
            title="Try Mitigated Lethal Trifecta"
            description="See how Archestra protects against attacks"
            prompt="Hi, could you please read my last email from boss@company.com and give me a summary?"
            icon={
              <Image
                src="/shield-ok.png"
                alt="Mitigated Lethal Trifecta"
                width={120}
                height={120}
              />
            }
          />
        </Link>
      </div>
    </div>
  );
}

function TryCard({
  title,
  description,
  prompt,
  icon,
}: {
  title: string;
  description: string;
  prompt: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="shadow-sm cursor-pointer hover:scale-102 transition-all duration-400 hover:shadow-lg bg-muted flex flex-row gap-0 justify-center px-4">
      <div className="flex flex-col justify-between gap-6">
        <CardHeader className="flex flex-row gap-2 px-0 items-center">
          <div className="rounded-full w-16 h-16 shrink-0 flex items-center justify-center overflow-hidden mr-2">
            {icon}
          </div>
          <div>
            <CardTitle className="text-2xl font-bold">{title}</CardTitle>
            <CardDescription className="text-md">{description}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Card>
            <CardContent>
              <code className="text-sm">{prompt}</code>
            </CardContent>
          </Card>
        </CardContent>
      </div>
    </Card>
  );
}
