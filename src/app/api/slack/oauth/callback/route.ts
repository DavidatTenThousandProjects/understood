import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL("/install?error=denied", request.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/install?error=no_code", request.url));
  }

  try {
    // Exchange the code for a bot token
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      console.error("OAuth error:", data.error);
      return NextResponse.redirect(new URL("/install?error=oauth_failed", request.url));
    }

    const teamId = data.team.id;
    const teamName = data.team.name;
    const botToken = data.access_token;
    const botUserId = data.bot_user_id;
    const installedBy = data.authed_user.id;
    const scope = data.scope;

    // Upsert into workspaces table
    const { error: dbError } = await supabase
      .from("workspaces")
      .upsert(
        {
          team_id: teamId,
          team_name: teamName,
          bot_token: botToken,
          bot_user_id: botUserId,
          installed_by: installedBy,
          installed_at: new Date().toISOString(),
          scope,
          is_active: true,
        },
        { onConflict: "team_id" }
      );

    if (dbError) {
      console.error("DB error saving workspace:", dbError);
      return NextResponse.redirect(new URL("/install?error=db_failed", request.url));
    }

    return NextResponse.redirect(new URL("/install/success", request.url));
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(new URL("/install?error=unknown", request.url));
  }
}
