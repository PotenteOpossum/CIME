// Test scenarios used by the development-only Test Lab. They mirror the two
// study scenarios so a test run looks like a real session.
export const SCENARIOS = {
  heimplatz: {
    label: "Heimplatz renovation",
    globalQuestion:
      "Should the City of Zurich renovate Heimplatz based on its preliminary design?",
    decisionContext:
      "Heimplatz is a busy square on Rämistrasse, framed by the Kunsthaus and the Schauspielhaus Pfauen and crossed by several tram lines. Today it is dominated by traffic and hard paving and offers little shade or space to stay. The City has prepared a preliminary design to make it greener and more pleasant while keeping it accessible for trams, deliveries to the cultural institutions and people with disabilities. This is a fictional research scenario.",
    topics: [
      {
        topic: "Trees and shade",
        question_text: "Where should trees be planted?",
        predefined_answers: [
          "Along the edges",
          "Across the square",
          "Only around seating areas",
          "In one dedicated green area",
        ],
      },
      {
        topic: "Car traffic and deliveries",
        question_text: "How should traffic on Rämistrasse be managed?",
        predefined_answers: [
          "Keep current arrangements",
          "Reduce through traffic",
          "Allow only deliveries and disability access",
          "Allow traffic only at certain hours",
        ],
      },
      {
        topic: "Car parking",
        question_text: "What should happen to the existing car parking spaces?",
        predefined_answers: [
          "Keep all parking spaces",
          "Replace some with green areas",
          "Replace some with bicycle parking",
          "Reduce parking spaces",
        ],
      },
      {
        topic: "Pedestrians and cyclists",
        question_text: "How should cycling be organized?",
        predefined_answers: [
          "Shared pedestrian and cycling space",
          "Separate cycling lanes",
          "Cycling only along the edges",
          "Pedestrian-only square",
        ],
      },
      {
        topic: "Use of the square",
        question_text: "What should the square be used for?",
        predefined_answers: [
          "Quiet seating and relaxation",
          "Cultural events, activities, and performances",
          "Bars and café terraces",
          "Markets and community activities",
        ],
      },
    ],
  },
  transit: {
    label: "CHF 365 subscription",
    globalQuestion:
      "Should the City of Zurich finance a scheme that allows eligible residents to buy an annual public transport subscription covering Zone 110 for CHF 365?",
    decisionContext:
      "An annual subscription for Zone 110, which covers the City of Zurich, currently costs considerably more than CHF 365. Following the example of Vienna's €365 annual ticket, the City would pay the difference for eligible residents. The measure aims to make public transport more affordable and to reduce car use, but it costs the City money every year, may increase crowding at peak hours and raises questions of fairness towards people who live outside the city. This is a fictional research scenario.",
    topics: [
      {
        topic: "Eligibility",
        question_text: "Who should be able to buy the CHF 365 subscription?",
        predefined_answers: [
          "All registered residents",
          "Only residents with lower incomes",
          "Only young people, students, and seniors",
          "All residents, with extra discounts for lower incomes",
        ],
      },
      {
        topic: "Funding",
        question_text: "How should the scheme be financed?",
        predefined_answers: [
          "Cut spending elsewhere in the budget",
          "Raise the municipal tax rate",
          "A small tax increase combined with some spending cuts",
          "Higher parking fees in the city",
        ],
      },
      {
        topic: "Peak-hour capacity",
        question_text: "How should crowding on trams and buses be handled?",
        predefined_answers: [
          "Keep current services and monitor demand",
          "Add trams and buses on crowded routes",
          "Encourage travel outside peak hours",
          "Expand the scheme only as capacity increases",
        ],
      },
      {
        topic: "Introduction",
        question_text: "How should the scheme be introduced?",
        predefined_answers: [
          "For all eligible residents at once",
          "In stages, one group at a time",
          "As a time-limited trial",
          "Only after capacity has been increased",
        ],
      },
      {
        topic: "Commuters",
        question_text:
          "Should people who work in Zurich but live outside the city benefit from the scheme?",
        predefined_answers: [
          "No, only city residents",
          "Yes, at a higher price",
          "Yes, if their employer contributes",
          "Yes, if their home municipality contributes",
        ],
      },
    ],
  },
};

export const NAMES = [
  "Anna", "Ben", "Carla", "David", "Elena", "Felix", "Gina", "Hugo",
  "Ines", "Jonas", "Klara", "Luca", "Mira", "Noah", "Olga",
];

// Short timers so a Full CIME test finishes in minutes, and small rooms so a
// handful of tabs is enough to form subgroups.
export const FAST_FULL_SETTINGS = {
  clustering_min_users_per_room: 2,
  clustering_min_rooms: 2,
  room_timer_minutes: 2,
  poll_timer_minutes: 1,
  live_voting_duration_minutes: 2,
  minimum_live_voting_duration_minutes: 1,
  convergence_summary_minutes: 1,
};
