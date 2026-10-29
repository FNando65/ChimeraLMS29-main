// Public landing page sections for Chimera Holdings.
// Kept separate from the LMS application logic so the public site can evolve independently.
const landingSections = document.getElementById("landing-sections");

if (landingSections) {
  landingSections.innerHTML = `
    <section class="about-section reference-about" id="about" aria-labelledby="about-heading">
      <div class="about-visual" aria-hidden="true"><div class="wireframe-sphere"></div></div>
      <div class="about-content">
        <div class="reference-section-label"><span>02</span><i></i><span>About Us</span></div>
        <h2 id="about-heading">Founded in 2013, Chimera Holdings has grown into a trusted leader in <span class="accent">ICT services and skills development.</span></h2>
        <p>With a hands-on, client-centric approach, we conceptualise and deliver innovative, fit-for-purpose solutions that drive growth, sustainability, and digital transformation.</p>
        <a class="reference-learn-more" href="https://chimeraholdings.co.za/about-us/" target="_blank" rel="noopener noreferrer">Learn more <span aria-hidden="true">↗</span></a>
      </div>
    </section>

    <section class="certificates-section" id="certificates" aria-labelledby="certificates-heading">
      <div class="certificates-inner">
        <div class="reference-section-label"><span>02</span><i></i><h2 id="certificates-heading">Occupational Certificates</h2></div>
        <div class="certificate-grid">
          <article class="certificate-card"><h3>Data Science Practitioner</h3><h4>Purpose and Rationale of Qualification:</h4><p>Data Science Practitioners take custody of data and make it available in a structured form for Data Scientists. They support the data life cycle by collecting, transforming, cleaning and analysing data, then communicating results to solve business problems. They transform data into robust, comprehensive data sets aligned with the identified needs and ready for storage.</p></article>
          <article class="certificate-card"><h3>AI Software Developer</h3><h4>Purpose and Rationale of Qualification:</h4><p>Artificial Intelligence (AI) Software Developers build intelligent functionality into software applications by integrating and implementing AI algorithms, models and logic within IT projects. They create and deploy AI driven solutions that analyse data, learn from patterns and make predictions, enhancing efficiency and innovation across industries.</p></article>
          <article class="certificate-card"><h3>Software Developer</h3><h4>Purpose and Rationale of Qualification:</h4><p>A Software Developer analyses requirements and translates them into functional software solutions using suitable programming languages and tools. They design, code, test and maintain applications that meet client, functional and technical needs, creating reliable, scalable and user-friendly systems.</p></article>
          <article class="certificate-card"><h3>Cybersecurity Analyst</h3><h4>Purpose and Rationale of Qualification:</h4><p>Cybersecurity Analysts protect networks, computer systems and information assets from malicious attacks and threats. They assess and mitigate risks, identify vulnerabilities, and maintain security in the working environment while ensuring legal compliance.</p></article>
          <article class="certificate-card"><h3>Project Manager</h3><h4>Purpose and Rationale of Qualification:</h4><p>A Project Manager applies project management knowledge to achieve objectives in a specific field. They lead projects of every scale, using planning and coordination skills across industries including ICT, human resources, advertising, marketing and construction.</p></article>
        </div>
      </div>
    </section>`;
}
