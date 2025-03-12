-- Insert tech tags
INSERT INTO tags (id, class, created_at, creator_id, title, handle, description, items_count) VALUES
(1, 'tech', '2024-01-01', 1, 'JavaScript', 'tech.javascript', 'JavaScript programming language', 15),
(2, 'tech', '2024-01-01', 1, 'Python', 'tech.python', 'Python programming language', 12),
(3, 'tech', '2024-01-01', 1, 'React', 'tech.react', 'React framework', 8),
(4, 'tech', '2024-01-01', 1, 'PostgreSQL', 'tech.postgresql', 'PostgreSQL database', 6),
(5, 'tech', '2024-01-01', 1, 'Node.js', 'tech.nodejs', 'Node.js runtime', 10);

-- Insert topic tags
INSERT INTO tags (id, class, created_at, creator_id, title, handle, description, items_count) VALUES
(6, 'topic', '2024-01-01', 1, 'Civic Engagement', 'topic.civic-engagement', 'Civic engagement projects', 8),
(7, 'topic', '2024-01-01', 1, 'Education', 'topic.education', 'Education-focused projects', 6),
(8, 'topic', '2024-01-01', 1, 'Transportation', 'topic.transportation', 'Transportation projects', 5),
(9, 'topic', '2024-01-01', 1, 'Health', 'topic.health', 'Healthcare projects', 4),
(10, 'topic', '2024-01-01', 1, 'Environment', 'topic.environment', 'Environmental projects', 7);

-- Insert event tags
INSERT INTO tags (id, class, created_at, creator_id, title, handle, description, items_count) VALUES
(11, 'event', '2024-01-01', 1, 'Civic Hackathon 2024', 'event.civic-hackathon-2024', 'Annual civic hackathon', 5),
(12, 'event', '2024-01-01', 1, 'Code Sprint 2024', 'event.code-sprint-2024', 'Quarterly code sprint', 3);

-- Insert projects
INSERT INTO projects (id, title, handle, created_at, creator_id, modified_at, maintainer_id, users_url, developers_url, readme, next_update, stage, chat_channel) VALUES
(1, 'Open Transit Map', 'open-transit-map', '2024-01-15', 1, '2024-03-01', 1, 'https://transit.example.com', 'https://github.com/example/transit', 'An interactive map of public transit routes', 1, 'Prototyping', 'transit-map'),
(2, 'School Resource Finder', 'school-finder', '2024-01-20', 2, '2024-02-28', 2, 'https://schools.example.com', 'https://github.com/example/schools', 'Find educational resources in your neighborhood', 2, 'Testing', 'school-finder'),
(3, 'Green Space Tracker', 'green-space', '2024-01-25', 3, '2024-03-05', 3, 'https://green.example.com', 'https://github.com/example/green', 'Track and discover green spaces in the city', 1, 'Maintaining', 'green-space'),
(4, 'Community Health Hub', 'health-hub', '2024-02-01', 4, '2024-03-10', 4, 'https://health.example.com', 'https://github.com/example/health', 'Connect with local health resources', 3, 'Prototyping', 'health-hub'),
(5, 'Civic Event Calendar', 'civic-calendar', '2024-02-05', 5, '2024-03-12', 5, 'https://events.example.com', 'https://github.com/example/events', 'Discover civic events in your area', 1, 'Testing', 'civic-calendar'),
(6, 'Volunteer Connect', 'volunteer-connect', '2024-02-10', 1, '2024-03-15', 1, 'https://volunteer.example.com', 'https://github.com/example/volunteer', 'Platform for connecting volunteers with opportunities', 2, 'Hibernating', 'volunteer-connect'),
(7, 'City Budget Visualizer', 'budget-viz', '2024-02-15', 2, '2024-03-18', 2, 'https://budget.example.com', 'https://github.com/example/budget', 'Visualize city budget allocation', 1, 'Maintaining', 'budget-viz'),
(8, 'Emergency Resource Locator', 'emergency-locator', '2024-02-20', 3, '2024-03-20', 3, 'https://emergency.example.com', 'https://github.com/example/emergency', 'Find emergency services near you', 2, 'Testing', 'emergency'),
(9, 'Bike Route Planner', 'bike-routes', '2024-02-25', 4, '2024-03-22', 4, 'https://bike.example.com', 'https://github.com/example/bike', 'Plan safe bike routes through the city', 1, 'Prototyping', 'bike-routes'),
(10, 'Community Forum', 'community-forum', '2024-03-01', 5, '2024-03-25', 5, 'https://forum.example.com', 'https://github.com/example/forum', 'Discuss local issues and initiatives', 3, 'Hibernating', 'community'),
(11, 'Food Bank Finder', 'food-bank-finder', '2024-03-05', 1, '2024-03-26', 1, 'https://food.example.com', 'https://github.com/example/food', 'Locate nearby food banks and pantries', 1, 'Testing', 'food-banks'),
(12, 'Public Art Map', 'art-map', '2024-03-08', 2, '2024-03-27', 2, 'https://art.example.com', 'https://github.com/example/art', 'Discover public art installations', 2, 'Prototyping', 'art-map'),
(13, 'Recycling Guide', 'recycling-guide', '2024-03-10', 3, '2024-03-28', 3, 'https://recycle.example.com', 'https://github.com/example/recycle', 'Learn about local recycling programs', 1, 'Maintaining', 'recycling'),
(14, 'Youth Programs Directory', 'youth-programs', '2024-03-12', 4, '2024-03-29', 4, 'https://youth.example.com', 'https://github.com/example/youth', 'Find programs for young people', 2, 'Testing', 'youth'),
(15, 'Senior Services Locator', 'senior-services', '2024-03-15', 5, '2024-03-30', 5, 'https://senior.example.com', 'https://github.com/example/senior', 'Connect seniors with local services', 1, 'Prototyping', 'senior'),
(16, 'Park Amenities Tracker', 'park-amenities', '2024-03-18', 1, '2024-04-01', 1, 'https://parks.example.com', 'https://github.com/example/parks', 'Find park features and facilities', 3, 'Hibernating', 'parks'),
(17, 'Local Business Directory', 'business-directory', '2024-03-20', 2, '2024-04-02', 2, 'https://business.example.com', 'https://github.com/example/business', 'Support local businesses', 1, 'Testing', 'business'),
(18, 'City Service Status', 'service-status', '2024-03-22', 3, '2024-04-03', 3, 'https://status.example.com', 'https://github.com/example/status', 'Track city service availability', 2, 'Maintaining', 'status'),
(19, 'Community Garden Map', 'garden-map', '2024-03-25', 4, '2024-04-04', 4, 'https://garden.example.com', 'https://github.com/example/garden', 'Find and join community gardens', 1, 'Prototyping', 'gardens'),
(20, 'Neighborhood Safety', 'neighborhood-safety', '2024-03-28', 5, '2024-04-05', 5, 'https://safety.example.com', 'https://github.com/example/safety', 'Track and report neighborhood safety issues', 2, 'Testing', 'safety');

-- Insert project-tag relationships
INSERT INTO project_tags (project_id, tag_id) VALUES
(1, 1), (1, 3), (1, 8), (1, 11),  -- Transit Map: JS, React, Transportation, Hackathon
(2, 2), (2, 7), (2, 11),          -- School Finder: Python, Education, Hackathon
(3, 1), (3, 10), (3, 12),         -- Green Space: JS, Environment, Sprint
(4, 2), (4, 9), (4, 11),          -- Health Hub: Python, Health, Hackathon
(5, 3), (5, 6), (5, 12),          -- Civic Calendar: React, Civic Engagement, Sprint
(6, 1), (6, 6), (6, 11),          -- Volunteer Connect: JS, Civic Engagement, Hackathon
(7, 2), (7, 4), (7, 12),          -- Budget Viz: Python, PostgreSQL, Sprint
(8, 3), (8, 9), (8, 11),          -- Emergency Locator: React, Health, Hackathon
(9, 1), (9, 8), (9, 12),          -- Bike Routes: JS, Transportation, Sprint
(10, 5), (10, 6), (10, 11),       -- Community Forum: Node.js, Civic Engagement, Hackathon
(11, 2), (11, 9), (11, 12),       -- Food Bank: Python, Health, Sprint
(12, 3), (12, 6), (12, 11),       -- Art Map: React, Civic Engagement, Hackathon
(13, 1), (13, 10), (13, 12),      -- Recycling: JS, Environment, Sprint
(14, 5), (14, 7), (14, 11),       -- Youth Programs: Node.js, Education, Hackathon
(15, 2), (15, 9), (15, 12),       -- Senior Services: Python, Health, Sprint
(16, 3), (16, 10), (16, 11),      -- Park Amenities: React, Environment, Hackathon
(17, 5), (17, 6), (17, 12),       -- Business Directory: Node.js, Civic Engagement, Sprint
(18, 1), (18, 4), (18, 11),       -- Service Status: JS, PostgreSQL, Hackathon
(19, 2), (19, 10), (19, 12),      -- Garden Map: Python, Environment, Sprint
(20, 3), (20, 6), (20, 11);       -- Neighborhood Safety: React, Civic Engagement, Hackathon
