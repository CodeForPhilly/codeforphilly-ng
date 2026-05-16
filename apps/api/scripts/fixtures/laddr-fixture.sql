-- Synthetic laddr mysqldump fixture for import-laddr tests.
-- Mirrors the shape (CREATE TABLE then INSERT) of real laddr dumps.

CREATE TABLE `people` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `Username` varchar(255) NOT NULL,
  `FirstName` varchar(255) DEFAULT NULL,
  `LastName` varchar(255) DEFAULT NULL,
  `FullName` varchar(255) DEFAULT NULL,
  `Email` varchar(255) DEFAULT NULL,
  `Password` varchar(255) DEFAULT NULL,
  `About` text DEFAULT NULL,
  `AccountLevel` varchar(64) DEFAULT 'User',
  `Created` datetime DEFAULT NULL,
  `Modified` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `people` VALUES (1,'jane-doe','Jane','Doe','Jane Doe','jane@example.com','$2y$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ','Civic technologist.','Administrator','2020-01-15 18:42:00','2024-05-01 09:00:00');
INSERT INTO `people` VALUES (2,'bobsmith','Bob','Smith',NULL,'bob@example.org','$2y$10$xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz','I like buses.','User','2021-06-20 12:00:00','2021-06-20 12:00:00'),(3,'Weird Name!','Carol','Singh','Carol Singh','carol@example.net',NULL,NULL,'User','2022-03-01 00:00:00','2022-03-01 00:00:00');
INSERT INTO `people` VALUES (4,'no-email','Dee','Park','Dee Park',NULL,NULL,NULL,'User','2023-01-01 00:00:00','2023-01-01 00:00:00');

CREATE TABLE `projects` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `Handle` varchar(255) NOT NULL,
  `Title` varchar(255) NOT NULL,
  `Summary` varchar(280) DEFAULT NULL,
  `README` text DEFAULT NULL,
  `Stage` varchar(64) DEFAULT 'Commenting',
  `MaintainerID` int(11) DEFAULT NULL,
  `UsersUrl` varchar(255) DEFAULT NULL,
  `DevelopersUrl` varchar(255) DEFAULT NULL,
  `ChatChannel` varchar(64) DEFAULT NULL,
  `Created` datetime DEFAULT NULL,
  `Modified` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `projects` VALUES (10,'squadquest','SquadQuest','Realtime events.','## Overview\n\nSquadQuest is a civic app.','Testing',1,'https://squadquest.app','https://github.com/example/squadquest','squadquest','2020-02-01 00:00:00','2024-04-15 00:00:00');
INSERT INTO `projects` VALUES (11,'transit-tools','Transit Tools','Better SEPTA info.',NULL,'Prototyping',2,NULL,'https://github.com/example/transit-tools','transit','2021-01-01 00:00:00','2021-01-01 00:00:00');

CREATE TABLE `project_members` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `ProjectID` int(11) NOT NULL,
  `PersonID` int(11) NOT NULL,
  `Role` varchar(255) DEFAULT NULL,
  `Joined` datetime DEFAULT NULL,
  `Created` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `project_members` VALUES (100,10,1,'Maintainer','2020-02-01 00:00:00','2020-02-01 00:00:00'),(101,10,2,'Backend Engineer','2020-03-01 00:00:00','2020-03-01 00:00:00'),(102,11,2,'Founder','2021-01-01 00:00:00','2021-01-01 00:00:00');

CREATE TABLE `project_updates` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `ProjectID` int(11) NOT NULL,
  `AuthorID` int(11) DEFAULT NULL,
  `Update` text NOT NULL,
  `Created` datetime DEFAULT NULL,
  `Modified` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `project_updates` VALUES (200,10,1,'We shipped v1.0!','2024-03-01 00:00:00','2024-03-01 00:00:00');
INSERT INTO `project_updates` VALUES (201,10,2,'Beta testers wanted.','2024-04-01 00:00:00','2024-04-01 00:00:00'),(202,11,2,'First commit.','2021-01-02 00:00:00','2021-01-02 00:00:00');

CREATE TABLE `project_buzz` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `ProjectID` int(11) NOT NULL,
  `PostedByID` int(11) DEFAULT NULL,
  `Headline` varchar(255) NOT NULL,
  `URL` varchar(500) NOT NULL,
  `Published` datetime DEFAULT NULL,
  `Summary` text DEFAULT NULL,
  `Created` datetime DEFAULT NULL,
  `Modified` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `project_buzz` VALUES (300,10,1,'The Inquirer praises SquadQuest','https://www.inquirer.com/tech/squadquest','2024-01-15 00:00:00','Great review.','2024-01-15 00:00:00','2024-01-15 00:00:00');

CREATE TABLE `tags` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `Handle` varchar(255) NOT NULL,
  `Title` varchar(255) NOT NULL,
  `Created` datetime DEFAULT NULL,
  `Modified` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `tags` VALUES (500,'tech.flutter','Flutter','2020-01-01 00:00:00','2020-01-01 00:00:00'),(501,'topic.transit','Transit','2020-01-01 00:00:00','2020-01-01 00:00:00'),(502,'event.hackathon','Hackathon','2020-01-01 00:00:00','2020-01-01 00:00:00');

CREATE TABLE `tag_items` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `TagID` int(11) NOT NULL,
  `ContextClass` varchar(255) NOT NULL,
  `ContextID` int(11) NOT NULL,
  `Created` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `tag_items` VALUES (600,500,'Emergence\\\\Models\\\\Project',10,'2020-02-01 00:00:00'),(601,501,'Emergence\\\\Models\\\\Project',11,'2021-01-01 00:00:00'),(602,500,'Emergence\\\\People\\\\Person',1,'2020-02-01 00:00:00');

-- Tables we deliberately skip per specs/deferred.md
CREATE TABLE `member_checkins` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `PersonID` int(11) NOT NULL,
  PRIMARY KEY (`ID`)
);

INSERT INTO `member_checkins` VALUES (1000,1);
