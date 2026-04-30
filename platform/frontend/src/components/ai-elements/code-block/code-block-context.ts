import { createContext } from "react";

type CodeBlockContextType = {
  code: string;
};

export const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});
