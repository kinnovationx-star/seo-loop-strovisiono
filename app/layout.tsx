import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./status.css";

export async function generateMetadata(): Promise<Metadata> { const values=await headers(); const host=values.get("x-forwarded-host")||values.get("host")||"localhost:3000"; const protocol=values.get("x-forwarded-proto")||((host.includes("localhost"))?"http":"https"); const origin=`${protocol}://${host}`; const title="SEO Loop | 自律型SEO運用"; const description="SEO分析、一次情報、記事制作、品質ゲート、投稿、PDCAをクライアント別に運用する管理システム"; return { title,description,openGraph:{title,description,images:[`${origin}/og.png`]},twitter:{card:"summary_large_image",title,description,images:[`${origin}/og.png`]}}; }
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }
