import { getChats } from "shared/api-client";

export default async function TestAgentPage() {
  try {
    const response = await getChats();

    console.log("Chats response:", response);
    console.log("Chats data:", response.data);
  } catch (error) {
    console.error("Error fetching chats:", error);
  }

  return "test agent page";
}
