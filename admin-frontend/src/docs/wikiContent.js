export const wikiDocs = [
  {
    "slug": "readme",
    "file": "README.md",
    "title": "CIME overview",
    "markdown": "# CIME: Collective Intelligence Made Easy\n\nCIME supports private interviews, topic-focused group discussions, voting, and collective review. Administrators configure the decision and manage participants. Language models assist conversation; backend rules control ballots and transitions.\n\nThe participant interface provides assigned rooms, discussions, voting, and an agent monitor. The administrator interface provides process configuration, user management, facilitation settings, quality analysis, and optional simulated participants.\n"
  },
  {
    "slug": "03-user-guide",
    "file": "03-user-guide.md",
    "title": "Participant guide",
    "markdown": "# Participant guide\n\nSign in with the credentials supplied by your administrator. Open your assigned personal room and answer the facilitator's questions. Follow the process into your discussion group, contribute reasons for your views, and review the available voting options.\n\nWhere enabled, revise your live vote or propose an additional option. During collective review, examine subgroup outcomes and request that topics be reopened before the final vote. The Agent Monitor explains the current process stage.\n"
  },
  {
    "slug": "04-admin-guide",
    "file": "04-admin-guide.md",
    "title": "Administrator guide",
    "markdown": "# Administrator guide\n\nCreate participant accounts before starting a decision. Configure the main question, background, deliberation topics, initial options, grouping settings, and voting timers. Start the process and monitor rooms and participant progress.\n\nThe AI Models settings control model selection. Prompt configuration controls facilitation instructions. Quality analysis combines participation indicators with automated assessments; these assessments do not establish that a collective decision is correct.\n\nThe Simulation tab runs synthetic participants through the app. Configure their personas and starting perspectives before starting. Simulation, AI autofill, facilitation, and quality analysis can incur API charges. Synthetic behavior is not evidence of how people would behave.\n\nConversation data, model prompts, responses, and account records are stored locally by the backend. Protect these files and any exported reports. Consult the repository README for setup and deployment.\n"
  }
];
