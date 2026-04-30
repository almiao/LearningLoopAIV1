export const javaCollectionsDocument = `
Java collections provide the core data structures used in backend services. Lists preserve order and allow duplicates, while sets focus on uniqueness. HashMap is optimized for key lookup but depends on stable hashing and equals contracts.

Concurrency changes the tradeoffs. ConcurrentHashMap reduces lock contention by segmenting internal coordination. CopyOnWriteArrayList favors read-heavy workloads because every mutation copies the backing array.

When discussing backend interview scenarios, candidates should explain not only the APIs but also why one collection is chosen under a given workload. They should be able to reason about memory usage, iteration guarantees, and failure cases such as ConcurrentModificationException.
`;

export const springBootArticleHtml = `
<html>
  <head><title>Spring Boot Lifecycle Notes</title></head>
  <body>
    <article>
      <h1>Spring Boot Lifecycle</h1>
      <p>Spring Boot creates an application context, scans beans, applies configuration, and starts the embedded web server.</p>
      <p>Dependency injection keeps wiring explicit. Auto-configuration should be understood as conditional defaults rather than magic.</p>
      <p>Interview answers should connect lifecycle hooks, bean scopes, and startup diagnostics.</p>
    </article>
  </body>
</html>
`;

export const mysqlTransactionsDocument = `
MySQL transaction isolation controls what one transaction can observe from another. Read committed reduces dirty reads, while repeatable read is the default in InnoDB and prevents non-repeatable reads through MVCC snapshots.

Indexes improve query performance by narrowing scanned rows. A composite index only works efficiently when the query respects the leftmost prefix rule. Backend engineers should explain when covering indexes help and when an index can be ignored.
`;

export const aqsMarkdownDocument = `
---
title: AQS 详解
description: AQS抽象队列同步器深度解析
category: Java
tag:
  - Java并发
head:
  - - meta
    - name: description
      content: AQS,AbstractQueuedSynchronizer,CLH队列
---

## AQS 介绍

AQS 的全称是 AbstractQueuedSynchronizer。它是一个抽象类，主要用来构建锁和同步器，比如 ReentrantLock 和 Semaphore。

## AQS 的作用是什么？

AQS 提供了资源获取和释放的通用框架，把线程排队、阻塞唤醒这些复杂逻辑收敛起来。开发者通常只需要聚焦具体同步语义，而不必重复实现底层线程协调。

## AQS 为什么使用 CLH 锁队列的变体？

纯自旋会浪费 CPU，并且高并发下容易产生饥饿问题。AQS 在 CLH 的基础上做了两类关键改造：一是自旋加阻塞，二是从单向队列演进为更适合唤醒后继节点的双向队列。

## AQS 核心思想

AQS 用 volatile state 表示同步状态，用 FIFO 等待队列管理竞争资源失败的线程。线程获取失败后会进入等待队列，并在合适时机被唤醒重新竞争。

## 自定义同步器

如果要基于 AQS 实现自己的同步器，通常需要重写 tryAcquire、tryRelease、tryAcquireShared、tryReleaseShared 这些模板方法。

\`\`\`java
protected boolean tryAcquire(int arg)
protected boolean tryRelease(int arg)
\`\`\`
`;

export const noisyUrlHtml = `
<html>
  <head><title>Noise</title></head>
  <body>
    <div>Buy now</div>
    <div>subscribe</div>
    <div>sale sale sale</div>
  </body>
</html>
`;
