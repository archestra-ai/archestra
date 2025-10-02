import { getChats } from "shared/api-client";
import HistoryPage from "./page.client";

export default async function HistoryPageServer() {
  const chats = await getChats();
  return <HistoryPage initialData={chats.data} />;
}
