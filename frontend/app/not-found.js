import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <section className="panel">
        <h1>页面不存在</h1>
        <p className="lede">当前路由没有对应页面，返回主工作台继续操作。</p>
        <div className="actions">
          <Link className="secondary" href="/">返回首页</Link>
        </div>
      </section>
    </main>
  );
}
